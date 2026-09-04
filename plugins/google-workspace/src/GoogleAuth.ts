/**
 * Mints and caches Google OAuth2 access tokens for the configured credential.
 *
 * The credential is re-resolved on every mint from the `ConfigProvider` in effect when the layer
 * was built (the process environment by default), so a secrets refresh is picked up without
 * reloading the plugin. Tokens are cached until one minute before expiry; concurrent callers
 * share a single mint.
 *
 * Token flows by credential kind:
 *
 *   OAuthRefresh      refresh_token grant at oauth2.googleapis.com
 *   ServiceAccount    RS256 JWT signed locally with the key → jwt-bearer grant at the key's token_uri
 *   WorkloadIdentity  amp orb id-token → STS token exchange (a federated token) → then either
 *                       generateAccessToken on the service account (acting as the robot), or
 *                       signJwt on the service account → jwt-bearer grant (acting as a person
 *                       through domain-wide delegation). No private key is ever held.
 */
import { Amp } from "@scenesystems/amp-plugin-core"
import * as Clock from "effect/Clock"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Context from "effect/Context"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Match from "effect/Match"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import * as Semaphore from "effect/Semaphore"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as Credential from "./Credential.ts"
import { ErrorBody, GeneratedAccessToken, SignedJwt, TokenError, TokenResponse } from "./Model.ts"
import { SubjectToken } from "./SubjectToken.ts"

/**
 * Service shape.
 *
 * @category models
 */
export interface Shape {
  /** The configured credential, resolved from the environment on each call. */
  readonly credential: Effect.Effect<Credential.Credential, Credential.CredentialError>
  /** The Drive scope requested for tokens. */
  readonly scope: Effect.Effect<string, Credential.CredentialError>
  /** Whether `GOOGLE_WORKSPACE_READ_ONLY` disables the write tools. */
  readonly readOnly: Effect.Effect<boolean, Credential.CredentialError>
  /** A valid access token, minted or served from cache. */
  readonly accessToken: Effect.Effect<Redacted.Redacted, Credential.CredentialError>
  /** Drops the cached token so the next `accessToken` mints a fresh one. */
  readonly invalidate: Effect.Effect<void>
}

/**
 * @category services
 */
export class GoogleAuth extends Context.Service<GoogleAuth, Shape>()("@scenesystems/google-workspace/GoogleAuth") {}

interface CachedToken {
  readonly token: Redacted.Redacted
  readonly expiresAtMillis: number
}

const REFRESH_MARGIN_MILLIS = 60_000

/**
 * Services `make` and `layer` need: Amp for the user's email, an HTTP client for the token
 * endpoints, a file system for `GOOGLE_SERVICE_ACCOUNT_KEY_FILE`, and the subject-token source for
 * workload identity.
 *
 * @category models
 */
export type Requirements = Amp.Amp | HttpClient.HttpClient | FileSystem.FileSystem | SubjectToken

/**
 * Google's OAuth2 token endpoint, used by the refresh-token grant and every jwt-bearer grant that
 * is not tied to a key file's own `token_uri`.
 *
 * @category constants
 */
export const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token"

/**
 * Google Security Token Service: exchanges an external OIDC token for a federated access token.
 *
 * @category constants
 */
export const STS_TOKEN_URL = "https://sts.googleapis.com/v1/token"

/**
 * IAM Credentials API method URL for a service account (`generateAccessToken`, `signJwt`, ...).
 *
 * @category constants
 */
export const iamCredentialsUrl = (serviceAccountEmail: string, method: string): string =>
  `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${
    encodeURIComponent(serviceAccountEmail)
  }:${method}`

/** Lifetime requested for impersonated tokens; Google's default and maximum without an org policy change. */
const IMPERSONATED_TOKEN_LIFETIME = "3600s"

const configError = (error: { readonly message: string }) =>
  new Credential.CredentialError({ message: `Invalid Google credential configuration: ${error.message}` })

const cryptoError = (step: string) => (error: unknown) =>
  new Credential.CredentialError({
    message: `Could not ${step} with the service account private key: ${
      error instanceof Error ? error.message : String(error)
    }`,
    hint: "The key must be the unmodified \"private_key\" (PKCS#8 PEM) from the downloaded JSON."
  })

const pemToDer = (pem: string) => Encoding.decodeBase64(pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""))

const JwtHeader = Schema.fromJsonString(Schema.Struct({ alg: Schema.Literal("RS256"), typ: Schema.Literal("JWT") }))
const JwtClaims = Schema.fromJsonString(
  Schema.Struct({
    iss: Schema.String,
    scope: Schema.String,
    aud: Schema.String,
    iat: Schema.Finite,
    exp: Schema.Finite,
    sub: Schema.optionalKey(Schema.String)
  })
)
const encodeHeader = Schema.encodeSync(JwtHeader)
const encodeClaims = Schema.encodeSync(JwtClaims)

/**
 * The claim set of a jwt-bearer assertion (Google's "service account authorization" JWT), as the
 * JSON string that gets signed: issuer, requested scope, audience (the token endpoint), a one-hour
 * validity window, and `sub` when acting as a person through domain-wide delegation.
 *
 * @category constructors
 */
export const assertionClaims = (options: {
  readonly issuer: string
  readonly subject: Option.Option<string>
  readonly scope: string
  readonly audience: string
  readonly nowSeconds: number
}): string => {
  const base = {
    iss: options.issuer,
    scope: options.scope,
    aud: options.audience,
    iat: options.nowSeconds,
    exp: options.nowSeconds + 3600
  }
  return encodeClaims(Option.isSome(options.subject) ? { ...base, sub: options.subject.value } : base)
}

/**
 * Builds and signs the RS256 JWT assertion for the service-account token grant.
 *
 * @category constructors
 */
export const signServiceAccountJwt = (
  credential: Credential.ServiceAccount,
  scope: string,
  nowSeconds: number
): Effect.Effect<string, Credential.CredentialError> =>
  Effect.gen(function*() {
    const header = Encoding.encodeBase64Url(encodeHeader({ alg: "RS256", typ: "JWT" }))
    const payload = Encoding.encodeBase64Url(
      assertionClaims({
        issuer: credential.clientEmail,
        subject: credential.subject,
        scope,
        audience: credential.tokenUri,
        nowSeconds
      })
    )
    const der = new Uint8Array(
      yield* Effect.mapError(Effect.fromResult(pemToDer(Redacted.value(credential.privateKey))), cryptoError("decode"))
    )
    const key = yield* Effect.tryPromise({
      try: () => crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]),
      catch: cryptoError("import")
    })
    const signature = yield* Effect.tryPromise({
      try: () => crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${payload}`)),
      catch: cryptoError("sign")
    })
    return `${header}.${payload}.${Encoding.encodeBase64Url(new Uint8Array(signature))}`
  })

const decodeTokenError = Schema.decodeUnknownOption(Schema.fromJsonString(TokenError))
const decodeErrorBody = Schema.decodeUnknownOption(Schema.fromJsonString(ErrorBody))

/**
 * One line from an error body: `error: error_description` for an OAuth2/STS body,
 * `status: message` for a Google API envelope, else the raw body, else a placeholder.
 */
const summarizeErrorBody = (text: string): string => {
  const oauth = decodeTokenError(text).pipe(
    Option.map((body) => [body.error, body.error_description]),
    Option.filter((parts) => parts.some((p) => p !== undefined && p !== ""))
  )
  const api = decodeErrorBody(text).pipe(
    Option.map((body) => [body.error?.status, body.error?.message]),
    Option.filter((parts) => parts.some((p) => p !== undefined && p !== ""))
  )
  return Option.orElse(oauth, () => api).pipe(
    Option.map((parts) => parts.filter((p) => p !== undefined && p !== "").join(": ")),
    Option.getOrElse(() => text === "" ? "empty response body" : text.slice(0, 500))
  )
}

/** One HTTP exchange in a token flow, named for error messages. */
interface TokenCall {
  /** Subject of the failure message, e.g. "Google token request". */
  readonly request: string
  /** Subject of the decode-failure message, e.g. "Google token response". */
  readonly response: string
  /** What the success body must carry, e.g. "an access_token". */
  readonly expected: string
  /** Attached to a non-2xx failure. */
  readonly hint: string | undefined
}

/**
 * Hints attached to token failures, one per step that can be misconfigured.
 *
 * @category constants
 */
export const HINTS = {
  oauth: "The refresh token may be revoked; re-run the OAuth setup script.",
  serviceAccountKey:
    "Check that the key is current and, when impersonating, that domain-wide delegation grants this exact scope.",
  sts:
    "Check that GOOGLE_WORKLOAD_IDENTITY_PROVIDER names an existing provider whose attribute condition admits this Amp workspace, and that the provider's allowed audiences include its own https://iam.googleapis.com/... name (the default).",
  generateAccessToken:
    "Grant roles/iam.workloadIdentityUser on the service account to the pool's principalSet for this workspace (plugins/google-workspace/scripts/google-setup.sh does this), and enable iamcredentials.googleapis.com.",
  signJwt:
    "Grant roles/iam.serviceAccountTokenCreator on the service account to the pool's principalSet for this workspace (plugins/google-workspace/scripts/google-setup.sh --delegation does this).",
  delegation:
    "Domain-wide delegation must grant this service account's client ID this exact scope in the Google Workspace admin console."
}

/**
 * Builds the service from `Amp` (for the current user's email), an `HttpClient`, the `FileSystem`
 * used to read key files, and `SubjectToken` for workload identity.
 *
 * @category constructors
 */
export const make: Effect.Effect<Shape, never, Requirements> = Effect.gen(function*() {
  const amp = yield* Amp.Amp
  const client = yield* HttpClient.HttpClient
  const fs = yield* FileSystem.FileSystem
  const subjectTokens = yield* SubjectToken
  const configProvider = yield* ConfigProvider.ConfigProvider
  const cache = yield* Ref.make(Option.none<CachedToken>())
  const lock = yield* Semaphore.make(1)

  // Config is read lazily (on every mint) but always from the provider this layer was built with,
  // not from whatever context the calling tool happens to run in.
  const withConfig = <A, E>(self: Effect.Effect<A, E>): Effect.Effect<A, E> =>
    Effect.provideService(self, ConfigProvider.ConfigProvider, configProvider)

  const ampUserEmail = Option.fromNullishOr(amp.system.user?.email)
  const credential = withConfig(
    Effect.provideService(Credential.resolve({ ampUserEmail }), FileSystem.FileSystem, fs)
  )
  const scope = withConfig(Effect.mapError(Credential.scope, configError))
  const readOnly = withConfig(Effect.mapError(Credential.readOnly, configError))

  /** Executes one request of a token flow and decodes its success body; every failure is a `CredentialError`. */
  const call = <S extends Schema.Top>(
    cred: Credential.Credential,
    step: TokenCall,
    request: HttpClientRequest.HttpClientRequest,
    body: S
  ): Effect.Effect<S["Type"], Credential.CredentialError, S["DecodingServices"]> =>
    Effect.gen(function*() {
      const response = yield* client.execute(request).pipe(
        Effect.mapError((error) =>
          new Credential.CredentialError({
            message: `${step.request} failed for ${Credential.describe(cred)}: ${error.message}`
          })
        )
      )
      const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
      if (response.status < 200 || response.status >= 300) {
        return yield* new Credential.CredentialError({
          message: `${step.request} failed (${response.status}) for ${Credential.describe(cred)}: ${
            summarizeErrorBody(text)
          }`,
          hint: step.hint
        })
      }
      return yield* Schema.decodeEffect(Schema.fromJsonString(body))(text).pipe(
        Effect.mapError(() =>
          new Credential.CredentialError({ message: `${step.response} did not include ${step.expected}.` })
        )
      )
    })

  /** A grant at an OAuth2 token endpoint (refresh_token or jwt-bearer). */
  const oauthGrant = (
    cred: Credential.Credential,
    tokenUri: string,
    form: Record<string, string>,
    hint: string,
    nowMillis: number
  ): Effect.Effect<CachedToken, Credential.CredentialError> =>
    call(
      cred,
      { request: "Google token request", response: "Google token response", expected: "an access_token", hint },
      HttpClientRequest.post(tokenUri).pipe(HttpClientRequest.bodyUrlParams(form)),
      TokenResponse
    ).pipe(
      Effect.map((token) => ({
        token: Redacted.make(token.access_token),
        expiresAtMillis: nowMillis + (token.expires_in ?? 3600) * 1000
      }))
    )

  const mintOAuth = (cred: Credential.OAuthRefresh, nowMillis: number) =>
    oauthGrant(
      cred,
      OAUTH_TOKEN_URL,
      {
        grant_type: "refresh_token",
        client_id: cred.clientId,
        client_secret: Redacted.value(cred.clientSecret),
        refresh_token: Redacted.value(cred.refreshToken)
      },
      HINTS.oauth,
      nowMillis
    )

  const mintServiceAccount = (cred: Credential.ServiceAccount, requestedScope: string, nowMillis: number) =>
    Effect.gen(function*() {
      const assertion = yield* signServiceAccountJwt(cred, requestedScope, Math.floor(nowMillis / 1000))
      return yield* oauthGrant(
        cred,
        cred.tokenUri,
        { grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion },
        HINTS.serviceAccountKey,
        nowMillis
      )
    })

  const mintWorkloadIdentity = (cred: Credential.WorkloadIdentity, requestedScope: string, nowMillis: number) =>
    Effect.gen(function*() {
      const subjectToken = yield* subjectTokens.get(cred.subjectToken, Credential.oidcAudience(cred))
      const federated = yield* call(
        cred,
        {
          request: "Google STS token exchange",
          response: "Google STS response",
          expected: "an access_token",
          hint: HINTS.sts
        },
        HttpClientRequest.post(STS_TOKEN_URL).pipe(
          HttpClientRequest.bodyJsonUnsafe({
            grantType: "urn:ietf:params:oauth:grant-type:token-exchange",
            audience: Credential.stsAudience(cred),
            scope: "https://www.googleapis.com/auth/cloud-platform",
            requestedTokenType: "urn:ietf:params:oauth:token-type:access_token",
            subjectTokenType: "urn:ietf:params:oauth:token-type:jwt",
            subjectToken: Redacted.value(subjectToken)
          })
        ),
        TokenResponse
      )
      const asServiceAccount = (method: string, body: unknown) =>
        HttpClientRequest.post(iamCredentialsUrl(cred.serviceAccountEmail, method)).pipe(
          HttpClientRequest.bearerToken(federated.access_token),
          HttpClientRequest.bodyJsonUnsafe(body)
        )

      if (Option.isNone(cred.subject)) {
        const generated = yield* call(
          cred,
          {
            request: "Service account impersonation (generateAccessToken)",
            response: "generateAccessToken response",
            expected: "an accessToken and expireTime",
            hint: HINTS.generateAccessToken
          },
          asServiceAccount("generateAccessToken", { scope: [requestedScope], lifetime: IMPERSONATED_TOKEN_LIFETIME }),
          GeneratedAccessToken
        )
        const cached: CachedToken = {
          token: Redacted.make(generated.accessToken),
          expiresAtMillis: DateTime.toEpochMillis(generated.expireTime)
        }
        return cached
      }

      const signed = yield* call(
        cred,
        {
          request: "Service account signJwt",
          response: "signJwt response",
          expected: "a signedJwt",
          hint: HINTS.signJwt
        },
        asServiceAccount("signJwt", {
          payload: assertionClaims({
            issuer: cred.serviceAccountEmail,
            subject: cred.subject,
            scope: requestedScope,
            audience: OAUTH_TOKEN_URL,
            nowSeconds: Math.floor(nowMillis / 1000)
          })
        }),
        SignedJwt
      )
      return yield* oauthGrant(
        cred,
        OAUTH_TOKEN_URL,
        { grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: signed.signedJwt },
        HINTS.delegation,
        nowMillis
      )
    })

  const mint: Effect.Effect<CachedToken, Credential.CredentialError> = Effect.gen(function*() {
    const cred = yield* credential
    const nowMillis = yield* Clock.currentTimeMillis
    return yield* Match.valueTags(cred, {
      OAuthRefresh: (c) => mintOAuth(c, nowMillis),
      ServiceAccount: (c) => Effect.flatMap(scope, (s) => mintServiceAccount(c, s, nowMillis)),
      WorkloadIdentity: (c) => Effect.flatMap(scope, (s) => mintWorkloadIdentity(c, s, nowMillis))
    })
  })

  const accessToken = lock.withPermit(
    Effect.gen(function*() {
      const now = yield* Clock.currentTimeMillis
      const cached = yield* Ref.get(cache)
      if (Option.isSome(cached) && cached.value.expiresAtMillis - now > REFRESH_MARGIN_MILLIS) {
        return cached.value.token
      }
      const fresh = yield* mint
      yield* Ref.set(cache, Option.some(fresh))
      return fresh.token
    })
  )

  return GoogleAuth.of({
    credential,
    scope,
    readOnly,
    accessToken,
    invalidate: Ref.set(cache, Option.none())
  })
})

/**
 * @category layers
 */
export const layer: Layer.Layer<GoogleAuth, never, Requirements> = Layer.effect(GoogleAuth)(make)
