/**
 * Mints and caches Google OAuth2 access tokens for the configured credential.
 *
 * The credential is re-resolved on every mint, so a secrets refresh is picked up without
 * reloading the plugin. Tokens are cached until one minute before expiry; concurrent callers
 * share a single mint.
 *
 * @since 0.1.0
 */
import { Amp } from "@scenesystems/amp-plugin-core"
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import * as Semaphore from "effect/Semaphore"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as Credential from "./Credential.ts"
import { TokenError, TokenResponse } from "./Model.ts"

/**
 * Service shape.
 *
 * @since 0.1.0
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
 * @since 0.1.0
 * @category services
 */
export class GoogleAuth extends Context.Service<GoogleAuth, Shape>()("@scenesystems/google-workspace/GoogleAuth") {}

interface CachedToken {
  readonly token: Redacted.Redacted
  readonly expiresAtMillis: number
}

const REFRESH_MARGIN_MILLIS = 60_000

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
 * Builds and signs the RS256 JWT assertion for the service-account token grant.
 *
 * @since 0.1.0
 * @category constructors
 */
export const signServiceAccountJwt = (
  credential: Credential.ServiceAccount,
  scope: string,
  nowSeconds: number
): Effect.Effect<string, Credential.CredentialError> =>
  Effect.gen(function*() {
    const header = Encoding.encodeBase64Url(encodeHeader({ alg: "RS256", typ: "JWT" }))
    const base = {
      iss: credential.clientEmail,
      scope,
      aud: credential.tokenUri,
      iat: nowSeconds,
      exp: nowSeconds + 3600
    }
    const claims = Option.isSome(credential.subject) ? { ...base, sub: credential.subject.value } : base
    const payload = Encoding.encodeBase64Url(encodeClaims(claims))
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

const decodeTokenResponse = Schema.decodeUnknownEffect(TokenResponse)
const decodeTokenError = Schema.decodeUnknownOption(TokenError)

const summarizeTokenError = (body: unknown): string =>
  Option.match(decodeTokenError(body), {
    onNone: () => (typeof body === "string" ? body.slice(0, 500) : JSON.stringify(body).slice(0, 500)),
    onSome: (json) => {
      const parts = [json.error, json.error_description].filter((p) => p !== undefined && p !== "")
      return parts.length > 0 ? parts.join(": ") : JSON.stringify(body).slice(0, 500)
    }
  })

/**
 * Builds the service from `Amp` (for the current user's email) and an `HttpClient`.
 *
 * @since 0.1.0
 * @category constructors
 */
export const make: Effect.Effect<Shape, never, Amp.Amp | HttpClient.HttpClient> = Effect.gen(function*() {
  const amp = yield* Amp.Amp
  const client = yield* HttpClient.HttpClient
  const cache = yield* Ref.make(Option.none<CachedToken>())
  const lock = yield* Semaphore.make(1)

  const ampUserEmail = Option.fromNullishOr(amp.system.user?.email)
  const credential = Credential.resolve({ ampUserEmail })
  const scope = Effect.mapError(Credential.scope, configError)
  const readOnly = Effect.mapError(Credential.readOnly, configError)

  const mint: Effect.Effect<CachedToken, Credential.CredentialError> = Effect.gen(function*() {
    const cred = yield* credential
    const nowMillis = yield* Clock.currentTimeMillis
    const form = cred._tag === "OAuthRefresh"
      ? {
        grant_type: "refresh_token",
        client_id: cred.clientId,
        client_secret: Redacted.value(cred.clientSecret),
        refresh_token: Redacted.value(cred.refreshToken)
      }
      : {
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: yield* signServiceAccountJwt(cred, yield* scope, Math.floor(nowMillis / 1000))
      }
    const tokenUri = cred._tag === "OAuthRefresh" ? "https://oauth2.googleapis.com/token" : cred.tokenUri
    const request = HttpClientRequest.post(tokenUri).pipe(HttpClientRequest.bodyUrlParams(form))
    const response = yield* client.execute(request).pipe(
      Effect.mapError((error) =>
        new Credential.CredentialError({
          message: `Google token request failed for ${Credential.describe(cred)}: ${error.message}`
        })
      )
    )
    const body = yield* response.json.pipe(Effect.orElseSucceed(() => null))
    if (response.status < 200 || response.status >= 300) {
      return yield* new Credential.CredentialError({
        message: `Google token request failed (${response.status}) for ${Credential.describe(cred)}: ${
          summarizeTokenError(body)
        }`,
        hint: cred._tag === "ServiceAccount"
          ? "Check that the key is current and, when impersonating, that domain-wide delegation grants this exact scope."
          : "The refresh token may be revoked; re-run the OAuth setup script."
      })
    }
    const token = yield* decodeTokenResponse(body).pipe(
      Effect.mapError(() =>
        new Credential.CredentialError({ message: "Google token response did not include an access_token." })
      )
    )
    return {
      token: Redacted.make(token.access_token),
      expiresAtMillis: nowMillis + (token.expires_in ?? 3600) * 1000
    }
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
 * @since 0.1.0
 * @category layers
 */
export const layer: Layer.Layer<GoogleAuth, never, Amp.Amp | HttpClient.HttpClient> = Layer.effect(GoogleAuth)(make)
