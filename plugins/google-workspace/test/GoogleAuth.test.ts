import { describe, expect, it, TestClock } from "@scenesystems/amp-plugin-testing"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Credential from "../src/Credential.ts"
import { GoogleAuth, layer as GoogleAuthLayer, signServiceAccountJwt } from "../src/GoogleAuth.ts"
import { ampLayer, formBody, generateTestKey, jsonResponse, type Reply, stubClient } from "./support.ts"

const key = await generateTestKey()

const serviceAccount: Credential.ServiceAccount = {
  _tag: "ServiceAccount",
  clientEmail: key.clientEmail,
  privateKey: Redacted.make(
    Schema.decodeSync(Schema.fromJsonString(Schema.Struct({ private_key: Schema.String })))(key.json).private_key
  ),
  tokenUri: "https://oauth2.googleapis.com/token",
  subject: Option.none()
}

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
const base64Url = (segment: string): Uint8Array<ArrayBuffer> =>
  new Uint8Array(Result.getOrThrow(Encoding.decodeBase64Url(segment)))
const decodeSegment = (segment: string) => new TextDecoder().decode(base64Url(segment))
const decodeClaims = Schema.decodeEffect(Claims)

describe("signServiceAccountJwt", () => {
  it.effect("produces an RS256 JWT Google can verify with the public key", () =>
    Effect.gen(function*() {
      const jwt = yield* signServiceAccountJwt(serviceAccount, Credential.SCOPE_FULL, 1_700_000_000)
      const [header, payload, signature] = jwt.split(".")
      expect(header).toBeDefined()
      expect(payload).toBeDefined()
      expect(signature).toBeDefined()
      expect(jwt).not.toContain("=")

      expect(decodeSegment(header!)).toBe("{\"alg\":\"RS256\",\"typ\":\"JWT\"}")
      const claims = yield* decodeClaims(decodeSegment(payload!))
      expect(claims).toEqual({
        iss: key.clientEmail,
        scope: Credential.SCOPE_FULL,
        aud: "https://oauth2.googleapis.com/token",
        iat: 1_700_000_000,
        exp: 1_700_003_600
      })

      const valid = yield* Effect.promise(() =>
        crypto.subtle.verify(
          "RSASSA-PKCS1-v1_5",
          key.publicKey,
          base64Url(signature!),
          new TextEncoder().encode(`${header}.${payload}`)
        )
      )
      expect(valid).toBe(true)
    }))

  it.effect("adds `sub` when impersonating", () =>
    Effect.gen(function*() {
      const jwt = yield* signServiceAccountJwt(
        { ...serviceAccount, subject: Option.some("ari@acme.test") },
        Credential.SCOPE_READ_ONLY,
        0
      )
      const claims = yield* decodeClaims(decodeSegment(jwt.split(".")[1]!))
      expect(claims.sub).toBe("ari@acme.test")
      expect(claims.scope).toBe(Credential.SCOPE_READ_ONLY)
    }))

  it.effect("explains an unusable private key", () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(
        signServiceAccountJwt(
          {
            ...serviceAccount,
            privateKey: Redacted.make("-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----")
          },
          Credential.SCOPE_FULL,
          0
        )
      )
      expect(error._tag).toBe("CredentialError")
      expect(error.message).toContain("Could not import")
      expect(error.hint).toContain("PKCS#8")
    }))
})

const okToken: Reply = (_request, index) => jsonResponse({ access_token: `token-${index}`, expires_in: 3600 })

/**
 * `GoogleAuth` over a stub HTTP client. The `ConfigProvider` is provided to the whole program, not
 * only to the layer, because the service re-reads configuration on each call.
 */
const authLayer = (reply: Reply, env: Record<string, string>, email: string | null = "ari@acme.test") => {
  const http = stubClient(reply)
  const layer = GoogleAuthLayer.pipe(Layer.provide(http.layer), Layer.provide(ampLayer(email)))
  const run = <A, E>(program: Effect.Effect<A, E, GoogleAuth>) =>
    program.pipe(
      Effect.provide(layer),
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnvRecord(env))
    )
  return { ...http, run }
}

describe("GoogleAuth.accessToken", () => {
  it.effect("mints a service-account token with a JWT bearer grant and caches it", () =>
    Effect.gen(function*() {
      const auth = authLayer(okToken, { GOOGLE_SERVICE_ACCOUNT_KEY: key.json })
      const program = Effect.gen(function*() {
        const service = yield* GoogleAuth
        const first = yield* service.accessToken
        const second = yield* service.accessToken
        expect(Redacted.value(first)).toBe("token-0")
        expect(Redacted.value(second)).toBe("token-0")
        expect(auth.requests).toHaveLength(1)

        const recorded = auth.requests[0]!
        expect(recorded.request.method).toBe("POST")
        expect(recorded.url.href).toBe("https://oauth2.googleapis.com/token")
        const form = formBody(recorded)
        expect(form.grant_type).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer")
        expect(form.assertion!.split(".")).toHaveLength(3)

        // Concurrent callers share one mint.
        yield* service.invalidate
        yield* Effect.all([service.accessToken, service.accessToken, service.accessToken], { concurrency: 3 })
        expect(auth.requests).toHaveLength(2)
      })
      yield* auth.run(program)
    }))

  it.effect("re-mints one minute before expiry", () =>
    Effect.gen(function*() {
      const auth = authLayer(okToken, { GOOGLE_SERVICE_ACCOUNT_KEY: key.json })
      const program = Effect.gen(function*() {
        const service = yield* GoogleAuth
        expect(Redacted.value(yield* service.accessToken)).toBe("token-0")
        yield* TestClock.adjust("58 minutes")
        expect(Redacted.value(yield* service.accessToken)).toBe("token-0")
        yield* TestClock.adjust("90 seconds")
        expect(Redacted.value(yield* service.accessToken)).toBe("token-1")
        expect(auth.requests).toHaveLength(2)
      })
      yield* auth.run(program)
    }))

  it.effect("refreshes an OAuth credential with the refresh_token grant", () =>
    Effect.gen(function*() {
      const auth = authLayer(okToken, {
        GOOGLE_OAUTH_CLIENT_ID: "cid",
        GOOGLE_OAUTH_CLIENT_SECRET: "csecret",
        GOOGLE_OAUTH_REFRESH_TOKEN: "rtoken"
      })
      const program = Effect.gen(function*() {
        const service = yield* GoogleAuth
        expect(Redacted.value(yield* service.accessToken)).toBe("token-0")
        expect(formBody(auth.requests[0]!)).toEqual({
          grant_type: "refresh_token",
          client_id: "cid",
          client_secret: "csecret",
          refresh_token: "rtoken"
        })
      })
      yield* auth.run(program)
    }))

  it.effect("turns a token endpoint error into a CredentialError with the Google reason", () =>
    Effect.gen(function*() {
      const auth = authLayer(
        () => jsonResponse({ error: "invalid_grant", error_description: "Invalid JWT Signature." }, 400),
        { GOOGLE_SERVICE_ACCOUNT_KEY: key.json }
      )
      const error = yield* Effect.flip(auth.run(GoogleAuth.use((s) => s.accessToken)))
      expect(error._tag).toBe("CredentialError")
      expect(error.message).toMatch(/400.*invalid_grant: Invalid JWT Signature\./)
      expect(error.message).toContain(`service account ${key.clientEmail}`)
      expect(error.hint).toContain("domain-wide delegation")
    }))

  it.effect("fails without any credentials before touching the network", () =>
    Effect.gen(function*() {
      const auth = authLayer(okToken, {})
      const error = yield* Effect.flip(auth.run(GoogleAuth.use((s) => s.accessToken)))
      expect(error.message).toContain("No Google credentials configured")
      expect(auth.requests).toHaveLength(0)
    }))

  it.effect("uses the Amp user email for GOOGLE_IMPERSONATE_USER=amp-user", () =>
    Effect.gen(function*() {
      const auth = authLayer(okToken, { GOOGLE_SERVICE_ACCOUNT_KEY: key.json, GOOGLE_IMPERSONATE_USER: "amp-user" })
      const program = Effect.gen(function*() {
        const service = yield* GoogleAuth
        const credential = yield* service.credential
        expect(credential._tag === "ServiceAccount" && credential.subject).toEqual(Option.some("ari@acme.test"))
        yield* service.accessToken
        const claims = yield* decodeClaims(decodeSegment(formBody(auth.requests[0]!).assertion!.split(".")[1]!))
        expect(claims.sub).toBe("ari@acme.test")
      })
      yield* auth.run(program)
    }))
})
