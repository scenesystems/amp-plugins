import { describe, layer } from "@effect/vitest"
import * as Assert from "@effect/vitest/utils"
import { Amp } from "@scenesystems/amp-plugin-core"
import { Assert as ExitAssert, Http, PluginApi } from "@scenesystems/amp-plugin-testing"
import * as Arr from "effect/Array"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Record from "effect/Record"
import * as Redacted from "effect/Redacted"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as TestClock from "effect/testing/TestClock"
import * as Credential from "../src/Credential.ts"
import {
  assertionClaims,
  GoogleAuth,
  HINTS,
  iamCredentialsUrl,
  layer as GoogleAuthLayer,
  signServiceAccountJwt
} from "../src/GoogleAuth.ts"
import { type Shape as TestKeyShape, TestKey } from "./support/key.ts"
import * as Services from "./support/services.ts"

const Claims = Schema.fromJsonString(
  Schema.Struct({
    iss: Schema.String,
    scope: Schema.String,
    aud: Schema.String,
    iat: Schema.Finite,
    exp: Schema.Finite,
    sub: Schema.optionalKey(Schema.String)
  })
)
const decodeClaims = Schema.decodeEffect(Claims)
const base64Url = (segment: string): Uint8Array<ArrayBuffer> =>
  new Uint8Array(Result.getOrThrow(Encoding.decodeBase64Url(segment)))
const decodeSegment = (segment: string) => new TextDecoder().decode(base64Url(segment))

const splitJwt = (jwt: string): { header: string; payload: string; signature: string } => {
  const parts = jwt.split(".")
  Assert.strictEqual(parts.length, 3, `a JWT has three segments, got ${jwt}`)
  const [header, payload, signature] = Schema.decodeUnknownSync(
    Schema.Tuple([Schema.String, Schema.String, Schema.String])
  )(parts)
  return { header, payload, signature }
}

const verifySignature = (key: TestKeyShape, jwt: string) => {
  const { header, payload, signature } = splitJwt(jwt)
  return Effect.promise(() =>
    crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key.publicKey,
      base64Url(signature),
      new TextEncoder().encode(`${header}.${payload}`)
    )
  )
}

layer(TestKey.layer)("GoogleAuth", (it) => {
  describe("signServiceAccountJwt", () => {
    it.effect("produces an RS256 JWT whose signature verifies with the key's public half", () =>
      Effect.gen(function*() {
        const key = yield* TestKey
        const jwt = yield* signServiceAccountJwt(key.serviceAccount, Credential.SCOPE_FULL, 1_700_000_000)
        const { header, payload } = splitJwt(jwt)
        Assert.assertFalse(jwt.includes("="), "base64url segments must not be padded")
        Assert.strictEqual(decodeSegment(header), "{\"alg\":\"RS256\",\"typ\":\"JWT\"}")
        Assert.deepStrictEqual(yield* decodeClaims(decodeSegment(payload)), {
          iss: key.clientEmail,
          scope: Credential.SCOPE_FULL,
          aud: "https://oauth2.googleapis.com/token",
          iat: 1_700_000_000,
          exp: 1_700_003_600
        })
        Assert.assertTrue(yield* verifySignature(key, jwt), "signature must verify against the public key")
      }))

    it.effect("adds the impersonated user as `sub` and uses the credential's token URI as `aud`", () =>
      Effect.gen(function*() {
        const key = yield* TestKey
        const delegated: Credential.ServiceAccount = {
          ...key.serviceAccount,
          tokenUri: "https://oauth2.example.test/token",
          subject: Option.some("ari@scenesystems.io")
        }
        const jwt = yield* signServiceAccountJwt(delegated, Credential.SCOPE_READ_ONLY, 1_700_000_000)
        Assert.deepStrictEqual(yield* decodeClaims(decodeSegment(splitJwt(jwt).payload)), {
          iss: key.clientEmail,
          scope: Credential.SCOPE_READ_ONLY,
          aud: "https://oauth2.example.test/token",
          iat: 1_700_000_000,
          exp: 1_700_003_600,
          sub: "ari@scenesystems.io"
        })
        Assert.assertTrue(yield* verifySignature(key, jwt))
      }))

    it.effect("rejects a private key that is not base64 PEM", () =>
      Effect.gen(function*() {
        const key = yield* TestKey
        const broken = {
          ...key.serviceAccount,
          privateKey: Redacted.make("-----BEGIN PRIVATE KEY-----\n!!!\n-----END PRIVATE KEY-----")
        }
        const exit = yield* Effect.exit(signServiceAccountJwt(broken, Credential.SCOPE_FULL, 0))
        const error = ExitAssert.failureOf(exit)
        Assert.assertInstanceOf(error, Credential.CredentialError)
        Assert.assertMatch(error.message, /^Could not decode with the service account private key: /)
        Assert.strictEqual(
          error.hint,
          "The key must be the unmodified \"private_key\" (PKCS#8 PEM) from the downloaded JSON."
        )
      }))

    it.effect("rejects well-formed base64 that is not a PKCS#8 key", () =>
      Effect.gen(function*() {
        const key = yield* TestKey
        const notAKey = {
          ...key.serviceAccount,
          privateKey: Redacted.make(
            `-----BEGIN PRIVATE KEY-----\n${Encoding.encodeBase64("hello")}\n-----END PRIVATE KEY-----`
          )
        }
        const exit = yield* Effect.exit(signServiceAccountJwt(notAKey, Credential.SCOPE_FULL, 0))
        const error = ExitAssert.failureOf(exit)
        Assert.assertInstanceOf(error, Credential.CredentialError)
        Assert.assertMatch(error.message, /^Could not import with the service account private key: /)
        Assert.strictEqual(
          error.hint,
          "The key must be the unmodified \"private_key\" (PKCS#8 PEM) from the downloaded JSON."
        )
        ExitAssert.assertRedacted(error, ["hello"])
      }))
  })

  /** A syntactically valid JWT standing in for the orb's OIDC token; its content is never inspected by the plugin. */
  const ORB_JWT = "eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJhbXAifQ.c2ln"

  /** A `SubjectToken` that must not be asked for a token. */
  const noSubjectToken = Services.noSubjectToken

  /** The `GoogleAuth` service on top of a scripted HTTP client, an env record, a fake Amp, and a subject-token source. */
  const auth = (
    stub: Http.Stub,
    env: Record<string, string>,
    options: { readonly user?: string | null; readonly subjectToken?: Services.RecordingSubjectToken } = {}
  ) =>
    GoogleAuthLayer.pipe(
      Layer.provide([
        stub.layer,
        Amp.layer(
          PluginApi.make({ user: options.user === null ? null : PluginApi.user(options.user ?? "ari@example.test") })
            .api
        ),
        FileSystem.layerNoop({}),
        (options.subjectToken ?? noSubjectToken()).layer,
        ConfigProvider.layer(ConfigProvider.fromEnvRecord(env))
      ])
    )

  const token = (accessToken: string, expiresIn = 3600) =>
    Http.jsonResponse({ access_token: accessToken, expires_in: expiresIn })

  const serviceAccountEnv = (key: TestKeyShape) => ({ GOOGLE_SERVICE_ACCOUNT_KEY: key.json })
  const oauthEnv = {
    GOOGLE_OAUTH_CLIENT_ID: "client-id.apps.googleusercontent.com",
    GOOGLE_OAUTH_CLIENT_SECRET: "GOCSPX-secret",
    GOOGLE_OAUTH_REFRESH_TOKEN: "1//refresh"
  }
  const PROVIDER = Services.workloadIdentity.provider
  const SA_EMAIL = Services.workloadIdentity.serviceAccountEmail
  const wifEnv = {
    GOOGLE_WORKLOAD_IDENTITY_PROVIDER: PROVIDER,
    GOOGLE_SERVICE_ACCOUNT_EMAIL: SA_EMAIL
  }
  const WIF_DESCRIPTION = `workload identity for service account ${SA_EMAIL}`

  describe("GoogleAuth.accessToken", () => {
    it.effect("mints a service-account token with a jwt-bearer grant signed at the current clock time", () =>
      Effect.gen(function*() {
        const key = yield* TestKey
        const stub = Http.stub(() => token("ya29.first"))
        yield* TestClock.setTime(1_700_000_000_000)
        const minted = yield* GoogleAuth.use((a) => a.accessToken).pipe(
          Effect.provide(auth(stub, serviceAccountEnv(key)))
        )
        Assert.strictEqual(Redacted.value(minted), "ya29.first")

        Assert.strictEqual(stub.requests.length, 1)
        const request = Http.request(stub, 0)
        Assert.strictEqual(Http.endpoint(request), "POST https://oauth2.googleapis.com/token")
        Assert.strictEqual(request.request.headers["content-type"], "application/x-www-form-urlencoded")
        const form = Http.formBody(request)
        Assert.deepStrictEqual(Record.keys(form).sort(), ["assertion", "grant_type"])
        const decodedForm = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ assertion: Schema.String, grant_type: Schema.String })
        )(form)
        Assert.strictEqual(decodedForm.grant_type, "urn:ietf:params:oauth:grant-type:jwt-bearer")
        const claims = yield* decodeClaims(decodeSegment(splitJwt(decodedForm.assertion).payload))
        Assert.deepStrictEqual(claims, {
          iss: key.clientEmail,
          scope: Credential.SCOPE_FULL,
          aud: "https://oauth2.googleapis.com/token",
          iat: 1_700_000_000,
          exp: 1_700_003_600
        })
        Assert.assertTrue(yield* verifySignature(key, decodedForm.assertion))
      }))

    it.effect("requests the read-only scope and the Amp user's email as `sub` when configured", () =>
      Effect.gen(function*() {
        const key = yield* TestKey
        const stub = Http.stub(() => token("ya29.ro"))
        yield* GoogleAuth.use((a) => a.accessToken).pipe(
          Effect.provide(
            auth(stub, {
              ...serviceAccountEnv(key),
              GOOGLE_WORKSPACE_READ_ONLY: "1",
              GOOGLE_IMPERSONATE_USER: "amp-user"
            }, {
              user: "ari@scenesystems.io"
            })
          )
        )
        const form = Http.formBody(Http.request(stub, 0))
        Assert.deepStrictEqual(Record.keys(form).sort(), ["assertion", "grant_type"])
        const decodedForm = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ assertion: Schema.String, grant_type: Schema.String })
        )(form)
        const claims = yield* decodeClaims(decodeSegment(splitJwt(decodedForm.assertion).payload))
        Assert.strictEqual(claims.scope, Credential.SCOPE_READ_ONLY)
        Assert.strictEqual(claims.sub, "ari@scenesystems.io")
      }))

    it.effect("exchanges an OAuth refresh token at Google's token endpoint with the exact form fields", () =>
      Effect.gen(function*() {
        const stub = Http.stub(() => token("ya29.oauth"))
        const minted = yield* GoogleAuth.use((a) => a.accessToken).pipe(Effect.provide(auth(stub, oauthEnv)))
        Assert.strictEqual(Redacted.value(minted), "ya29.oauth")
        Assert.strictEqual(Http.endpoint(Http.request(stub, 0)), "POST https://oauth2.googleapis.com/token")
        Assert.deepStrictEqual(Http.formBody(Http.request(stub, 0)), {
          grant_type: "refresh_token",
          client_id: "client-id.apps.googleusercontent.com",
          client_secret: "GOCSPX-secret",
          refresh_token: "1//refresh"
        })
      }))

    it.effect("serves the cached token until 60 seconds before expiry, then mints again", () =>
      Effect.gen(function*() {
        const stub = Http.stub((_, index) => token(`ya29.${index}`, 3600))
        yield* Effect.gen(function*() {
          const a = yield* GoogleAuth
          const accessToken = Effect.map(a.accessToken, Redacted.value)
          Assert.strictEqual(yield* accessToken, "ya29.0")
          yield* TestClock.adjust(Duration.minutes(58))
          Assert.strictEqual(yield* accessToken, "ya29.0", "58 minutes in, the hour-long token is still fresh")
          Assert.strictEqual(stub.requests.length, 1)
          yield* TestClock.adjust(Duration.seconds(61))
          Assert.strictEqual(yield* accessToken, "ya29.1", "inside the 60 s margin a new token is minted")
          Assert.strictEqual(stub.requests.length, 2)
          Assert.strictEqual(yield* accessToken, "ya29.1")
          Assert.strictEqual(stub.requests.length, 2)
        }).pipe(Effect.provide(auth(stub, oauthEnv)))
      }))

    it.effect("re-mints after invalidate even when the cached token has not expired", () =>
      Effect.gen(function*() {
        const stub = Http.stub((_, index) => token(`ya29.${index}`))
        yield* Effect.gen(function*() {
          const a = yield* GoogleAuth
          Assert.strictEqual(Redacted.value(yield* a.accessToken), "ya29.0")
          yield* a.invalidate
          Assert.strictEqual(Redacted.value(yield* a.accessToken), "ya29.1")
          Assert.strictEqual(stub.requests.length, 2)
        }).pipe(Effect.provide(auth(stub, oauthEnv)))
      }))

    it.effect("lets concurrent callers share one mint", () =>
      Effect.gen(function*() {
        const stub = Http.stub((_, index) => token(`ya29.${index}`))
        yield* Effect.gen(function*() {
          const a = yield* GoogleAuth
          const tokens = yield* Effect.all(Arr.makeBy(8, () => a.accessToken), { concurrency: "unbounded" })
          Assert.deepStrictEqual(tokens.map(Redacted.value), Arr.makeBy(8, () => "ya29.0"))
          Assert.strictEqual(stub.requests.length, 1)
        }).pipe(Effect.provide(auth(stub, oauthEnv)))
      }))

    it.effect("treats a missing expires_in as one hour", () =>
      Effect.gen(function*() {
        const stub = Http.stub((_, index) => Http.jsonResponse({ access_token: `ya29.${index}` }))
        yield* Effect.gen(function*() {
          const a = yield* GoogleAuth
          Assert.strictEqual(Redacted.value(yield* a.accessToken), "ya29.0")
          yield* TestClock.adjust(Duration.minutes(58))
          Assert.strictEqual(Redacted.value(yield* a.accessToken), "ya29.0")
          yield* TestClock.adjust(Duration.seconds(61))
          Assert.strictEqual(Redacted.value(yield* a.accessToken), "ya29.1")
        }).pipe(Effect.provide(auth(stub, oauthEnv)))
      }))

    it.effect("re-reads the credential on every mint so a rotated secret takes effect without a reload", () =>
      Effect.gen(function*() {
        const stub = Http.stub((_, index) => token(`ya29.${index}`))
        const env: Record<string, string> = { ...oauthEnv }
        const live = ConfigProvider.make((path) => {
          const value = Option.fromNullishOr(env[path.join("_")])
          return Effect.succeed(Option.isNone(value) ? undefined : ConfigProvider.makeValue(value.value))
        })
        const layer = GoogleAuthLayer.pipe(
          Layer.provide([
            stub.layer,
            Amp.layer(PluginApi.make().api),
            FileSystem.layerNoop({}),
            noSubjectToken().layer,
            ConfigProvider.layer(live)
          ])
        )
        yield* Effect.gen(function*() {
          const a = yield* GoogleAuth
          yield* a.accessToken
          env["GOOGLE_OAUTH_REFRESH_TOKEN"] = "1//rotated"
          yield* a.invalidate
          yield* a.accessToken
          Assert.deepStrictEqual(stub.requests.map((r) => Http.formBody(r)["refresh_token"]), [
            "1//refresh",
            "1//rotated"
          ])
        }).pipe(Effect.provide(layer))
      }))

    describe("workload identity", () => {
      const STS = "POST https://sts.googleapis.com/v1/token"
      const GENERATE = `POST ${iamCredentialsUrl(SA_EMAIL, "generateAccessToken")}`
      const SIGN = `POST ${iamCredentialsUrl(SA_EMAIL, "signJwt")}`
      const TOKEN = "POST https://oauth2.googleapis.com/token"

      const federated = (accessToken = "ya29.federated") =>
        Http.jsonResponse({
          access_token: accessToken,
          issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
          token_type: "Bearer",
          expires_in: 3599
        })
      const generated = (accessToken: string, expireTime: string) => Http.jsonResponse({ accessToken, expireTime })
      const signed = (signedJwt: string) => Http.jsonResponse({ keyId: "abc123", signedJwt })

      /** STS then generateAccessToken, in that order; anything else is a scripting error. */
      const impersonation = (accessToken = "ya29.impersonated", expireTime = "2023-11-14T23:13:20Z") =>
        Http.script(() => federated(), () => generated(accessToken, expireTime))

      /** STS, signJwt, then the jwt-bearer grant. */
      const delegation = (signedJwt = "h.p.s") =>
        Http.script(() => federated(), () => signed(signedJwt), () => token("ya29.delegated", 3599))

      const orbToken = () => Services.subjectToken(() => ORB_JWT)

      it.effect("exchanges the orb token at STS with the exact request body, then impersonates the service account", () =>
        Effect.gen(function*() {
          const stub = impersonation()
          const subjectToken = orbToken()
          const minted = yield* GoogleAuth.use((a) => a.accessToken).pipe(
            Effect.provide(auth(stub, wifEnv, { subjectToken }))
          )
          Assert.strictEqual(Redacted.value(minted), "ya29.impersonated")

          Assert.deepStrictEqual(subjectToken.calls, [
            { source: { _tag: "AmpOrb" }, audience: `https://iam.googleapis.com/${PROVIDER}` }
          ])

          Assert.deepStrictEqual(stub.requests.map(Http.endpoint), [STS, GENERATE])
          const sts = Http.request(stub, 0)
          Assert.strictEqual(sts.request.headers["content-type"], "application/json")
          Assert.strictEqual(sts.request.headers["authorization"], undefined, "STS is unauthenticated")
          Assert.deepStrictEqual(Http.jsonBody(sts), {
            grantType: "urn:ietf:params:oauth:grant-type:token-exchange",
            audience: `//iam.googleapis.com/${PROVIDER}`,
            scope: "https://www.googleapis.com/auth/cloud-platform",
            requestedTokenType: "urn:ietf:params:oauth:token-type:access_token",
            subjectTokenType: "urn:ietf:params:oauth:token-type:jwt",
            subjectToken: ORB_JWT
          })

          const generate = Http.request(stub, 1)
          Assert.strictEqual(generate.request.headers["authorization"], "Bearer ya29.federated")
          Assert.strictEqual(generate.request.headers["content-type"], "application/json")
          Assert.deepStrictEqual(Http.jsonBody(generate), { scope: [Credential.SCOPE_FULL], lifetime: "3600s" })
        }))

      it.effect("requests the read-only scope from generateAccessToken when configured", () =>
        Effect.gen(function*() {
          const stub = impersonation()
          yield* GoogleAuth.use((a) => a.accessToken).pipe(
            Effect.provide(auth(stub, { ...wifEnv, GOOGLE_WORKSPACE_READ_ONLY: "1" }, { subjectToken: orbToken() }))
          )
          Assert.deepStrictEqual(Http.jsonBody(Http.request(stub, 1)), {
            scope: [Credential.SCOPE_READ_ONLY],
            lifetime: "3600s"
          })
        }))

      it.effect("takes the token's expiry from generateAccessToken's expireTime, not from the clock", () =>
        Effect.gen(function*() {
          // expireTime is 30 minutes after the test clock's epoch; the token is fresh until 60 s before it.
          yield* TestClock.setTime(Date.parse("2023-11-14T22:43:20Z"))
          const stub = Http.stub((_, index) =>
            index % 2 === 0 ? federated() : generated(`ya29.${(index - 1) / 2}`, "2023-11-14T23:13:20Z")
          )
          yield* Effect.gen(function*() {
            const a = yield* GoogleAuth
            const accessToken = Effect.map(a.accessToken, Redacted.value)
            Assert.strictEqual(yield* accessToken, "ya29.0")
            yield* TestClock.adjust(Duration.minutes(28))
            Assert.strictEqual(yield* accessToken, "ya29.0", "28 minutes in, the 30-minute token is still fresh")
            Assert.strictEqual(stub.requests.length, 2)
            yield* TestClock.adjust(Duration.seconds(61))
            Assert.strictEqual(yield* accessToken, "ya29.1", "inside the 60 s margin a new token is minted")
            Assert.strictEqual(stub.requests.length, 4)
          }).pipe(Effect.provide(auth(stub, wifEnv, { subjectToken: orbToken() })))
        }))

      it.effect("asks the subject-token source again on every mint: the orb token is never cached", () =>
        Effect.gen(function*() {
          const stub = Http.stub((_, index) =>
            index % 2 === 0 ? federated() : generated("ya29.x", "2030-01-01T00:00:00Z")
          )
          const subjectToken = Services.subjectToken((_, index) => `${ORB_JWT}${index}`)
          yield* Effect.gen(function*() {
            const a = yield* GoogleAuth
            yield* a.accessToken
            yield* a.invalidate
            yield* a.accessToken
          }).pipe(Effect.provide(auth(stub, wifEnv, { subjectToken })))
          Assert.strictEqual(subjectToken.calls.length, 2)
          const subjectTokens = yield* Effect.forEach(
            [Http.request(stub, 0), Http.request(stub, 2)],
            (r) => Schema.decodeUnknownEffect(Schema.Struct({ subjectToken: Schema.String }))(Http.jsonBody(r))
          )
          Assert.deepStrictEqual(subjectTokens.map((body) => body.subjectToken), [`${ORB_JWT}0`, `${ORB_JWT}1`])
        }))

      it.effect("reads the token from the configured file source, passing the same audience", () =>
        Effect.gen(function*() {
          const subjectToken = orbToken()
          yield* GoogleAuth.use((a) => a.accessToken).pipe(
            Effect.provide(
              auth(impersonation(), { ...wifEnv, GOOGLE_WORKLOAD_IDENTITY_TOKEN_FILE: "/var/run/oidc/token" }, {
                subjectToken
              })
            )
          )
          Assert.deepStrictEqual(subjectToken.calls, [
            {
              source: { _tag: "File", path: "/var/run/oidc/token" },
              audience: `https://iam.googleapis.com/${PROVIDER}`
            }
          ])
        }))

      it.effect("acts as a person via signJwt and a jwt-bearer grant when GOOGLE_IMPERSONATE_USER is set", () =>
        Effect.gen(function*() {
          yield* TestClock.setTime(1_700_000_000_000)
          const stub = delegation("signed.by.google")
          const minted = yield* GoogleAuth.use((a) => a.accessToken).pipe(
            Effect.provide(
              auth(stub, { ...wifEnv, GOOGLE_IMPERSONATE_USER: "amp-user", GOOGLE_WORKSPACE_READ_ONLY: "1" }, {
                user: "ari@scenesystems.io",
                subjectToken: orbToken()
              })
            )
          )
          Assert.strictEqual(Redacted.value(minted), "ya29.delegated")
          Assert.deepStrictEqual(stub.requests.map(Http.endpoint), [STS, SIGN, TOKEN])

          const sign = Http.request(stub, 1)
          Assert.strictEqual(sign.request.headers["authorization"], "Bearer ya29.federated")
          const rawBody = Http.jsonBody(sign)
          const bodyRecord = yield* Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.Unknown))(rawBody)
          Assert.deepStrictEqual(Record.keys(bodyRecord), ["payload"])
          const body = yield* Schema.decodeUnknownEffect(Schema.Struct({ payload: Schema.String }))(rawBody)
          Assert.deepStrictEqual(yield* decodeClaims(body.payload), {
            iss: SA_EMAIL,
            scope: Credential.SCOPE_READ_ONLY,
            aud: "https://oauth2.googleapis.com/token",
            iat: 1_700_000_000,
            exp: 1_700_003_600,
            sub: "ari@scenesystems.io"
          })
          Assert.strictEqual(
            body.payload,
            assertionClaims({
              issuer: SA_EMAIL,
              subject: Option.some("ari@scenesystems.io"),
              scope: Credential.SCOPE_READ_ONLY,
              audience: "https://oauth2.googleapis.com/token",
              nowSeconds: 1_700_000_000
            })
          )

          const grant = Http.request(stub, 2)
          Assert.strictEqual(
            grant.request.headers["authorization"],
            undefined,
            "the token endpoint takes the assertion, not a bearer"
          )
          Assert.deepStrictEqual(Http.formBody(grant), {
            grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
            assertion: "signed.by.google"
          })
        }))

      it.effect("makes no network call when the subject token cannot be obtained, and passes its error through", () =>
        Effect.gen(function*() {
          const stub = Http.script()
          const orbError = new Credential.CredentialError({
            message: "`amp orb id-token` exited with code 1: not inside an orb",
            hint: "Workload identity works only inside Amp orbs."
          })
          const exit = yield* GoogleAuth.use((a) => a.accessToken).pipe(
            Effect.provide(auth(stub, wifEnv, { subjectToken: Services.subjectToken(() => orbError) })),
            Effect.exit
          )
          ExitAssert.assertFails(exit, orbError)
          Assert.strictEqual(stub.requests.length, 0)
        }))

      describe("failures", () => {
        it.effect("names the STS exchange, summarises the OAuth-style error body, and hints at the provider condition", () =>
          Effect.gen(function*() {
            const stub = Http.stub(() =>
              Http.jsonResponse({
                error: "invalid_grant",
                error_description: "The audience in the token does not match the audience of the provider."
              }, 400)
            )
            const exit = yield* GoogleAuth.use((a) => a.accessToken).pipe(
              Effect.provide(auth(stub, wifEnv, { subjectToken: orbToken() })),
              Effect.exit
            )
            ExitAssert.assertFails(
              exit,
              new Credential.CredentialError({
                message:
                  `Google STS token exchange failed (400) for ${WIF_DESCRIPTION}: invalid_grant: The audience in the token does not match the audience of the provider.`,
                hint: HINTS.sts
              })
            )
            Assert.strictEqual(stub.requests.length, 1)
          }))

        it.effect("names the impersonation step, summarises the API error envelope, and hints at workloadIdentityUser", () =>
          Effect.gen(function*() {
            const stub = Http.stub((_, index) =>
              index === 0
                ? federated()
                : Http.jsonResponse({
                  error: {
                    code: 403,
                    message:
                      "Permission 'iam.serviceAccounts.getAccessToken' denied on resource (or it may not exist).",
                    status: "PERMISSION_DENIED"
                  }
                }, 403)
            )
            const exit = yield* GoogleAuth.use((a) => a.accessToken).pipe(
              Effect.provide(auth(stub, wifEnv, { subjectToken: orbToken() })),
              Effect.exit
            )
            ExitAssert.assertFails(
              exit,
              new Credential.CredentialError({
                message:
                  `Service account impersonation (generateAccessToken) failed (403) for ${WIF_DESCRIPTION}: PERMISSION_DENIED: Permission 'iam.serviceAccounts.getAccessToken' denied on resource (or it may not exist).`,
                hint: HINTS.generateAccessToken
              })
            )
          }))

        it.effect("names the signJwt step and hints at serviceAccountTokenCreator", () =>
          Effect.gen(function*() {
            const stub = Http.stub((_, index) =>
              index === 0
                ? federated()
                : Http.jsonResponse({ error: { code: 403, message: "denied", status: "PERMISSION_DENIED" } }, 403)
            )
            const exit = yield* GoogleAuth.use((a) => a.accessToken).pipe(
              Effect.provide(auth(stub, { ...wifEnv, GOOGLE_IMPERSONATE_USER: "ari@scenesystems.io" }, {
                subjectToken: orbToken()
              })),
              Effect.exit
            )
            ExitAssert.assertFails(
              exit,
              new Credential.CredentialError({
                message:
                  `Service account signJwt failed (403) for ${WIF_DESCRIPTION} impersonating ari@scenesystems.io: PERMISSION_DENIED: denied`,
                hint: HINTS.signJwt
              })
            )
          }))

        it.effect("points at domain-wide delegation when Google rejects the delegated assertion", () =>
          Effect.gen(function*() {
            const stub = Http.stub((_, index) =>
              index === 0
                ? federated()
                : index === 1
                ? signed("h.p.s")
                : Http.jsonResponse({
                  error: "unauthorized_client",
                  error_description:
                    "Client is unauthorized to retrieve access tokens using this method, or client not authorized for any of the scopes requested."
                }, 401)
            )
            const exit = yield* GoogleAuth.use((a) => a.accessToken).pipe(
              Effect.provide(auth(stub, { ...wifEnv, GOOGLE_IMPERSONATE_USER: "ari@scenesystems.io" }, {
                subjectToken: orbToken()
              })),
              Effect.exit
            )
            ExitAssert.assertFails(
              exit,
              new Credential.CredentialError({
                message:
                  `Google token request failed (401) for ${WIF_DESCRIPTION} impersonating ari@scenesystems.io: unauthorized_client: Client is unauthorized to retrieve access tokens using this method, or client not authorized for any of the scopes requested.`,
                hint: HINTS.delegation
              })
            )
          }))

        it.effect.each([
          {
            step: "STS",
            index: 0,
            body: { token_type: "Bearer" },
            expected: "Google STS response did not include an access_token."
          },
          {
            step: "generateAccessToken",
            index: 1,
            body: { accessToken: "ya29.x" },
            expected: "generateAccessToken response did not include an accessToken and expireTime."
          },
          {
            step: "generateAccessToken",
            index: 1,
            body: { accessToken: "ya29.x", expireTime: "tomorrow" },
            expected: "generateAccessToken response did not include an accessToken and expireTime."
          }
        ])(
          "fails when the $step response is missing or malformed: $expected",
          ({ body, expected, index }) =>
            Effect.gen(function*() {
              const stub = Http.stub((_, i) => i === index ? Http.jsonResponse(body) : federated())
              const exit = yield* GoogleAuth.use((a) => a.accessToken).pipe(
                Effect.provide(auth(stub, wifEnv, { subjectToken: orbToken() })),
                Effect.exit
              )
              ExitAssert.assertFails(exit, new Credential.CredentialError({ message: expected }))
            })
        )

        it.effect("fails when the signJwt response carries no signedJwt", () =>
          Effect.gen(function*() {
            const stub = Http.stub((_, index) => index === 0 ? federated() : Http.jsonResponse({ keyId: "abc" }))
            const exit = yield* GoogleAuth.use((a) => a.accessToken).pipe(
              Effect.provide(auth(stub, { ...wifEnv, GOOGLE_IMPERSONATE_USER: "ari@scenesystems.io" }, {
                subjectToken: orbToken()
              })),
              Effect.exit
            )
            ExitAssert.assertFails(
              exit,
              new Credential.CredentialError({ message: "signJwt response did not include a signedJwt." })
            )
          }))

        it.effect("reports a transport failure at STS with the credential's description and no hint", () =>
          Effect.gen(function*() {
            const stub = Http.failingTransport("getaddrinfo ENOTFOUND sts.googleapis.com")
            const exit = yield* GoogleAuth.use((a) => a.accessToken).pipe(
              Effect.provide(auth(stub, wifEnv, { subjectToken: orbToken() })),
              Effect.exit
            )
            const error = ExitAssert.failureOf(exit)
            Assert.assertInstanceOf(error, Credential.CredentialError)
            Assert.strictEqual(error.hint, undefined)
            Assert.assertMatch(
              error.message,
              new RegExp(
                `^Google STS token exchange failed for ${
                  WIF_DESCRIPTION.replace(/[.@]/g, "\\$&")
                }: .*getaddrinfo ENOTFOUND sts\\.googleapis\\.com`
              )
            )
          }))

        it.effect("never leaks the orb token or the federated token into a failure", () =>
          Effect.gen(function*() {
            const stub = Http.stub((_, index) =>
              index === 0
                ? federated("ya29.federated-secret")
                : Http.jsonResponse({ error: { status: "PERMISSION_DENIED" } }, 403)
            )
            const exit = yield* GoogleAuth.use((a) => a.accessToken).pipe(
              Effect.provide(auth(stub, wifEnv, { subjectToken: orbToken() })),
              Effect.exit
            )
            ExitAssert.assertRedacted(ExitAssert.failureOf(exit), [ORB_JWT, "ya29.federated-secret"])
          }))
      })
    })

    describe("failures", () => {
      it.effect("fails without any network call when no credentials are configured", () =>
        Effect.gen(function*() {
          const stub = Http.script()
          const exit = yield* GoogleAuth.use((a) => a.accessToken).pipe(Effect.provide(auth(stub, {})), Effect.exit)
          const error = ExitAssert.failureOf(exit)
          Assert.assertInstanceOf(error, Credential.CredentialError)
          Assert.assertMatch(error.message, /^No Google credentials configured\.\n/)
          Assert.strictEqual(stub.requests.length, 0)
        }))

      it.effect("reports a transport failure with the credential's description", () =>
        Effect.gen(function*() {
          const stub = Http.failingTransport("getaddrinfo ENOTFOUND oauth2.googleapis.com")
          const exit = yield* GoogleAuth.use((a) => a.accessToken).pipe(
            Effect.provide(auth(stub, oauthEnv)),
            Effect.exit
          )
          const error = ExitAssert.failureOf(exit)
          Assert.assertInstanceOf(error, Credential.CredentialError)
          Assert.strictEqual(error.hint, undefined)
          Assert.assertMatch(
            error.message,
            /^Google token request failed for OAuth user credential \(client client-id\.apps\.googleusercontent\.com\): .*getaddrinfo ENOTFOUND oauth2\.googleapis\.com/
          )
          Assert.strictEqual(stub.requests.length, 1)
        }))

      it.effect("summarises Google's error body for a rejected service-account grant", () =>
        Effect.gen(function*() {
          const key = yield* TestKey
          const stub = Http.stub(() =>
            Http.jsonResponse({ error: "invalid_grant", error_description: "Invalid JWT Signature." }, 400)
          )
          const exit = yield* GoogleAuth.use((a) => a.accessToken).pipe(
            Effect.provide(auth(stub, { ...serviceAccountEnv(key), GOOGLE_IMPERSONATE_USER: "ari@scenesystems.io" })),
            Effect.exit
          )
          ExitAssert.assertFails(
            exit,
            new Credential.CredentialError({
              message:
                `Google token request failed (400) for service account ${key.clientEmail} impersonating ari@scenesystems.io: invalid_grant: Invalid JWT Signature.`,
              hint:
                "Check that the key is current and, when impersonating, that domain-wide delegation grants this exact scope."
            })
          )
        }))

      it.effect("points at the OAuth setup script when a refresh token is rejected", () =>
        Effect.gen(function*() {
          const stub = Http.stub(() => Http.jsonResponse({ error: "invalid_grant" }, 400))
          const exit = yield* GoogleAuth.use((a) => a.accessToken).pipe(
            Effect.provide(auth(stub, oauthEnv)),
            Effect.exit
          )
          ExitAssert.assertFails(
            exit,
            new Credential.CredentialError({
              message:
                "Google token request failed (400) for OAuth user credential (client client-id.apps.googleusercontent.com): invalid_grant",
              hint: "The refresh token may be revoked; re-run the OAuth setup script."
            })
          )
        }))

      it.effect("falls back to the raw body for a non-JSON error response", () =>
        Effect.gen(function*() {
          const stub = Http.stub(() => Http.textResponse("<html>502 Bad Gateway</html>", 502, "text/html"))
          const exit = yield* GoogleAuth.use((a) => a.accessToken).pipe(
            Effect.provide(auth(stub, oauthEnv)),
            Effect.exit
          )
          ExitAssert.assertFails(
            exit,
            new Credential.CredentialError({
              message:
                "Google token request failed (502) for OAuth user credential (client client-id.apps.googleusercontent.com): <html>502 Bad Gateway</html>",
              hint: "The refresh token may be revoked; re-run the OAuth setup script."
            })
          )
        }))

      it.effect("says so when an error response has no body at all", () =>
        Effect.gen(function*() {
          const stub = Http.stub(() => Http.emptyResponse(500))
          const exit = yield* GoogleAuth.use((a) => a.accessToken).pipe(
            Effect.provide(auth(stub, oauthEnv)),
            Effect.exit
          )
          ExitAssert.assertFails(
            exit,
            new Credential.CredentialError({
              message:
                "Google token request failed (500) for OAuth user credential (client client-id.apps.googleusercontent.com): empty response body",
              hint: "The refresh token may be revoked; re-run the OAuth setup script."
            })
          )
        }))

      it.effect("fails when a 200 response is not JSON", () =>
        Effect.gen(function*() {
          const stub = Http.stub(() => Http.textResponse("ok"))
          const exit = yield* GoogleAuth.use((a) => a.accessToken).pipe(
            Effect.provide(auth(stub, oauthEnv)),
            Effect.exit
          )
          ExitAssert.assertFails(
            exit,
            new Credential.CredentialError({ message: "Google token response did not include an access_token." })
          )
        }))

      it.effect("fails when a 200 response carries no access_token", () =>
        Effect.gen(function*() {
          const stub = Http.stub(() => Http.jsonResponse({ token_type: "Bearer", expires_in: 3599 }))
          const exit = yield* GoogleAuth.use((a) => a.accessToken).pipe(
            Effect.provide(auth(stub, oauthEnv)),
            Effect.exit
          )
          ExitAssert.assertFails(
            exit,
            new Credential.CredentialError({ message: "Google token response did not include an access_token." })
          )
        }))

      it.effect("never leaks the client secret or refresh token into a token failure", () =>
        Effect.gen(function*() {
          const stub = Http.stub(() => Http.jsonResponse({ error: "invalid_client" }, 401))
          const exit = yield* GoogleAuth.use((a) => a.accessToken).pipe(
            Effect.provide(auth(stub, oauthEnv)),
            Effect.exit
          )
          ExitAssert.assertRedacted(ExitAssert.failureOf(exit), ["GOCSPX-secret", "1//refresh"])
        }))

      it.effect("does not cache a failed mint: the next call tries again", () =>
        Effect.gen(function*() {
          const stub = Http.stub((_, index) =>
            index === 0 ? Http.jsonResponse({ error: "temporarily_unavailable" }, 503) : token("ya29.ok")
          )
          yield* Effect.gen(function*() {
            const a = yield* GoogleAuth
            Assert.assertInstanceOf(ExitAssert.failureOf(yield* Effect.exit(a.accessToken)), Credential.CredentialError)
            Assert.strictEqual(Redacted.value(yield* a.accessToken), "ya29.ok")
            Assert.strictEqual(stub.requests.length, 2)
          }).pipe(Effect.provide(auth(stub, oauthEnv)))
        }))
    })
  })

  describe("GoogleAuth.credential, scope, readOnly", () => {
    it.effect("expose the resolved credential and the configured mode", () =>
      Effect.gen(function*() {
        const key = yield* TestKey
        const stub = Http.script()
        yield* Effect.gen(function*() {
          const a = yield* GoogleAuth
          Assert.assertEquals(yield* a.credential, key.serviceAccount)
          Assert.strictEqual(yield* a.scope, Credential.SCOPE_READ_ONLY)
          Assert.strictEqual(yield* a.readOnly, true)
        }).pipe(Effect.provide(auth(stub, { ...serviceAccountEnv(key), GOOGLE_WORKSPACE_READ_ONLY: "true" })))
        Assert.strictEqual(stub.requests.length, 0)
      }))

    it.effect("report a bad GOOGLE_WORKSPACE_READ_ONLY value as a configuration error without a hint", () =>
      Effect.gen(function*() {
        const key = yield* TestKey
        const stub = Http.stub(() => token("unused"))
        const exit = yield* GoogleAuth.use((a) => a.readOnly).pipe(
          Effect.provide(auth(stub, { ...serviceAccountEnv(key), GOOGLE_WORKSPACE_READ_ONLY: "maybe" })),
          Effect.exit
        )
        ExitAssert.assertFails(
          exit,
          new Credential.CredentialError({
            message:
              "Invalid Google credential configuration: SchemaError(Expected \"true\" | \"yes\" | \"on\" | \"1\" | \"y\" | \"false\" | \"no\" | \"off\" | \"0\" | \"n\"\n  at [\"GOOGLE_WORKSPACE_READ_ONLY\"])"
          })
        )
      }))
  })
})
