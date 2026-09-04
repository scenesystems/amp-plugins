import { describe, it } from "@effect/vitest"
import * as Assert from "@effect/vitest/utils"
import { Amp } from "@scenesystems/amp-plugin-core"
import { Assert as ExitAssert, Http, PluginApi } from "@scenesystems/amp-plugin-testing"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as TestClock from "effect/testing/TestClock"
import * as Credential from "../src/Credential.ts"
import { GoogleAuth, layer as GoogleAuthLayer, signServiceAccountJwt } from "../src/GoogleAuth.ts"
import { generateTestKey } from "./support/key.ts"

const key = await generateTestKey()

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
  return { header: parts[0]!, payload: parts[1]!, signature: parts[2]! }
}

const verifySignature = (jwt: string) => {
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

describe("signServiceAccountJwt", () => {
  it.effect("produces an RS256 JWT whose signature verifies with the key's public half", () =>
    Effect.gen(function*() {
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
      Assert.assertTrue(yield* verifySignature(jwt), "signature must verify against the public key")
    }))

  it.effect("adds the impersonated user as `sub` and uses the credential's token URI as `aud`", () =>
    Effect.gen(function*() {
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
      Assert.assertTrue(yield* verifySignature(jwt))
    }))

  it.effect("rejects a private key that is not base64 PEM", () =>
    Effect.gen(function*() {
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

/** The `GoogleAuth` service on top of a scripted HTTP client, an env record, and a fake Amp. */
const auth = (
  stub: Http.Stub,
  env: Record<string, string>,
  options: { readonly user?: string | null } = {}
) =>
  GoogleAuthLayer.pipe(
    Layer.provide([
      stub.layer,
      Amp.layer(
        PluginApi.make({ user: options.user === null ? null : PluginApi.user(options.user ?? "ari@example.test") }).api
      ),
      FileSystem.layerNoop({}),
      ConfigProvider.layer(ConfigProvider.fromEnvRecord(env))
    ])
  )

const token = (accessToken: string, expiresIn = 3600) =>
  Http.jsonResponse({ access_token: accessToken, expires_in: expiresIn })

const serviceAccountEnv = { GOOGLE_SERVICE_ACCOUNT_KEY: key.json }
const oauthEnv = {
  GOOGLE_OAUTH_CLIENT_ID: "client-id.apps.googleusercontent.com",
  GOOGLE_OAUTH_CLIENT_SECRET: "GOCSPX-secret",
  GOOGLE_OAUTH_REFRESH_TOKEN: "1//refresh"
}

describe("GoogleAuth.accessToken", () => {
  it.effect("mints a service-account token with a jwt-bearer grant signed at the current clock time", () =>
    Effect.gen(function*() {
      const stub = Http.stub(() => token("ya29.first"))
      yield* TestClock.setTime(1_700_000_000_000)
      const minted = yield* GoogleAuth.use((a) => a.accessToken).pipe(Effect.provide(auth(stub, serviceAccountEnv)))
      Assert.strictEqual(Redacted.value(minted), "ya29.first")

      Assert.strictEqual(stub.requests.length, 1)
      const request = stub.requests[0]!
      Assert.strictEqual(Http.endpoint(request), "POST https://oauth2.googleapis.com/token")
      Assert.strictEqual(request.request.headers["content-type"], "application/x-www-form-urlencoded")
      const form = Http.formBody(request)
      Assert.deepStrictEqual(Object.keys(form).sort(), ["assertion", "grant_type"])
      Assert.strictEqual(form["grant_type"], "urn:ietf:params:oauth:grant-type:jwt-bearer")
      const claims = yield* decodeClaims(decodeSegment(splitJwt(form["assertion"]!).payload))
      Assert.deepStrictEqual(claims, {
        iss: key.clientEmail,
        scope: Credential.SCOPE_FULL,
        aud: "https://oauth2.googleapis.com/token",
        iat: 1_700_000_000,
        exp: 1_700_003_600
      })
      Assert.assertTrue(yield* verifySignature(form["assertion"]!))
    }))

  it.effect("requests the read-only scope and the Amp user's email as `sub` when configured", () =>
    Effect.gen(function*() {
      const stub = Http.stub(() => token("ya29.ro"))
      yield* GoogleAuth.use((a) => a.accessToken).pipe(
        Effect.provide(
          auth(stub, { ...serviceAccountEnv, GOOGLE_WORKSPACE_READ_ONLY: "1", GOOGLE_IMPERSONATE_USER: "amp-user" }, {
            user: "ari@scenesystems.io"
          })
        )
      )
      const claims = yield* decodeClaims(
        decodeSegment(splitJwt(Http.formBody(stub.requests[0]!)["assertion"]!).payload)
      )
      Assert.strictEqual(claims.scope, Credential.SCOPE_READ_ONLY)
      Assert.strictEqual(claims.sub, "ari@scenesystems.io")
    }))

  it.effect("exchanges an OAuth refresh token at Google's token endpoint with the exact form fields", () =>
    Effect.gen(function*() {
      const stub = Http.stub(() => token("ya29.oauth"))
      const minted = yield* GoogleAuth.use((a) => a.accessToken).pipe(Effect.provide(auth(stub, oauthEnv)))
      Assert.strictEqual(Redacted.value(minted), "ya29.oauth")
      Assert.strictEqual(Http.endpoint(stub.requests[0]!), "POST https://oauth2.googleapis.com/token")
      Assert.deepStrictEqual(Http.formBody(stub.requests[0]!), {
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
        const tokens = yield* Effect.all(Array.from({ length: 8 }, () => a.accessToken), { concurrency: "unbounded" })
        Assert.deepStrictEqual(tokens.map(Redacted.value), Array.from({ length: 8 }, () => "ya29.0"))
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
      const live = ConfigProvider.make((path) =>
        Effect.succeed(env[path.join("_")] === undefined ? undefined : ConfigProvider.makeValue(env[path.join("_")]!))
      )
      const layer = GoogleAuthLayer.pipe(
        Layer.provide([
          stub.layer,
          Amp.layer(PluginApi.make().api),
          FileSystem.layerNoop({}),
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

  describe("failures", () => {
    it.effect("fails without any network call when no credentials are configured", () =>
      Effect.gen(function*() {
        const stub = Http.stub(() => {
          throw new Error("the token endpoint must not be called")
        })
        const exit = yield* GoogleAuth.use((a) => a.accessToken).pipe(Effect.provide(auth(stub, {})), Effect.exit)
        const error = ExitAssert.failureOf(exit)
        Assert.assertInstanceOf(error, Credential.CredentialError)
        Assert.assertMatch(error.message, /^No Google credentials configured\.\n/)
        Assert.strictEqual(stub.requests.length, 0)
      }))

    it.effect("reports a transport failure with the credential's description", () =>
      Effect.gen(function*() {
        const stub = Http.failingTransport("getaddrinfo ENOTFOUND oauth2.googleapis.com")
        const exit = yield* GoogleAuth.use((a) => a.accessToken).pipe(Effect.provide(auth(stub, oauthEnv)), Effect.exit)
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
        const stub = Http.stub(() =>
          Http.jsonResponse({ error: "invalid_grant", error_description: "Invalid JWT Signature." }, 400)
        )
        const exit = yield* GoogleAuth.use((a) => a.accessToken).pipe(
          Effect.provide(auth(stub, { ...serviceAccountEnv, GOOGLE_IMPERSONATE_USER: "ari@scenesystems.io" })),
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
        const exit = yield* GoogleAuth.use((a) => a.accessToken).pipe(Effect.provide(auth(stub, oauthEnv)), Effect.exit)
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
        const exit = yield* GoogleAuth.use((a) => a.accessToken).pipe(Effect.provide(auth(stub, oauthEnv)), Effect.exit)
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
        const exit = yield* GoogleAuth.use((a) => a.accessToken).pipe(Effect.provide(auth(stub, oauthEnv)), Effect.exit)
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
        const exit = yield* GoogleAuth.use((a) => a.accessToken).pipe(Effect.provide(auth(stub, oauthEnv)), Effect.exit)
        ExitAssert.assertFails(
          exit,
          new Credential.CredentialError({ message: "Google token response did not include an access_token." })
        )
      }))

    it.effect("fails when a 200 response carries no access_token", () =>
      Effect.gen(function*() {
        const stub = Http.stub(() => Http.jsonResponse({ token_type: "Bearer", expires_in: 3599 }))
        const exit = yield* GoogleAuth.use((a) => a.accessToken).pipe(Effect.provide(auth(stub, oauthEnv)), Effect.exit)
        ExitAssert.assertFails(
          exit,
          new Credential.CredentialError({ message: "Google token response did not include an access_token." })
        )
      }))

    it.effect("never leaks the client secret or refresh token into a token failure", () =>
      Effect.gen(function*() {
        const stub = Http.stub(() => Http.jsonResponse({ error: "invalid_client" }, 401))
        const exit = yield* GoogleAuth.use((a) => a.accessToken).pipe(Effect.provide(auth(stub, oauthEnv)), Effect.exit)
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
      const stub = Http.stub(() => {
        throw new Error("no network needed")
      })
      yield* Effect.gen(function*() {
        const a = yield* GoogleAuth
        Assert.assertEquals(yield* a.credential, key.serviceAccount)
        Assert.strictEqual(yield* a.scope, Credential.SCOPE_READ_ONLY)
        Assert.strictEqual(yield* a.readOnly, true)
      }).pipe(Effect.provide(auth(stub, { ...serviceAccountEnv, GOOGLE_WORKSPACE_READ_ONLY: "true" })))
      Assert.strictEqual(stub.requests.length, 0)
    }))

  it.effect("report a bad GOOGLE_WORKSPACE_READ_ONLY value as a configuration error without a hint", () =>
    Effect.gen(function*() {
      const stub = Http.stub(() => token("unused"))
      const exit = yield* GoogleAuth.use((a) => a.readOnly).pipe(
        Effect.provide(auth(stub, { ...serviceAccountEnv, GOOGLE_WORKSPACE_READ_ONLY: "maybe" })),
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
