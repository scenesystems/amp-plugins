import { describe, expect, it, test } from "@scenesystems/amp-plugin-testing"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Credential from "../src/Credential.ts"
import { generateTestKey } from "./support.ts"

const key = await generateTestKey()

const withEnv = (env: Record<string, string | undefined>) =>
  Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnvRecord(env))

const resolve = (env: Record<string, string | undefined>, ampUserEmail: Option.Option<string> = Option.none()) =>
  Credential.resolve({ ampUserEmail }).pipe(withEnv(env))

const failure = (env: Record<string, string | undefined>, ampUserEmail?: Option.Option<string>) =>
  Effect.flip(resolve(env, ampUserEmail))

describe("Credential.resolve", () => {
  it.effect("fails with setup guidance when nothing is configured", () =>
    Effect.gen(function*() {
      const error = yield* failure({})
      expect(error._tag).toBe("CredentialError")
      expect(error.message).toContain("No Google credentials configured")
      expect(error.message).toContain("GOOGLE_SERVICE_ACCOUNT_KEY")
      expect(error.hint).toContain("reference/setup.md")
    }))

  it.effect("parses an inline service account key", () =>
    Effect.gen(function*() {
      const credential = yield* resolve({ GOOGLE_SERVICE_ACCOUNT_KEY: key.json })
      expect(credential._tag).toBe("ServiceAccount")
      if (credential._tag === "ServiceAccount") {
        expect(credential.clientEmail).toBe(key.clientEmail)
        expect(credential.tokenUri).toBe("https://oauth2.googleapis.com/token")
        expect(credential.subject).toEqual(Option.none())
        expect(Redacted.value(credential.privateKey)).toStartWith("-----BEGIN PRIVATE KEY-----")
      }
    }))

  it.effect("reads the key from GOOGLE_SERVICE_ACCOUNT_KEY_FILE and GOOGLE_APPLICATION_CREDENTIALS", () =>
    Effect.gen(function*() {
      const path = `/tmp/amp-google-workspace-test-${Bun.randomUUIDv7()}.json`
      yield* Effect.promise(() => Bun.write(path, key.json))
      const fromFile = yield* resolve({ GOOGLE_SERVICE_ACCOUNT_KEY_FILE: path })
      const fromAdc = yield* resolve({ GOOGLE_APPLICATION_CREDENTIALS: path })
      yield* Effect.promise(() => Bun.file(path).delete())
      expect(fromFile._tag).toBe("ServiceAccount")
      expect(fromAdc._tag).toBe("ServiceAccount")
      const missing = yield* failure({ GOOGLE_SERVICE_ACCOUNT_KEY_FILE: path })
      expect(missing.message).toContain(`Cannot read service account key file ${path}`)
    }))

  it.effect("rejects a key that is not service account JSON", () =>
    Effect.gen(function*() {
      const error = yield* failure({ GOOGLE_SERVICE_ACCOUNT_KEY: "{\"nope\":true}" })
      expect(error.message).toContain("not valid JSON with \"client_email\" and \"private_key\"")
      expect(error.hint).toContain("--data-file key.json")
    }))

  it.effect("impersonates a fixed user or the Amp user", () =>
    Effect.gen(function*() {
      const fixed = yield* resolve({ GOOGLE_SERVICE_ACCOUNT_KEY: key.json, GOOGLE_IMPERSONATE_USER: "bot@acme.test" })
      expect(fixed._tag === "ServiceAccount" && fixed.subject).toEqual(Option.some("bot@acme.test"))

      const ampUser = yield* resolve(
        { GOOGLE_SERVICE_ACCOUNT_KEY: key.json, GOOGLE_IMPERSONATE_USER: "Amp-User" },
        Option.some("ari@acme.test")
      )
      expect(ampUser._tag === "ServiceAccount" && ampUser.subject).toEqual(Option.some("ari@acme.test"))

      const anonymous = yield* failure({ GOOGLE_SERVICE_ACCOUNT_KEY: key.json, GOOGLE_IMPERSONATE_USER: "amp-user" })
      expect(anonymous.message).toContain("Amp user email is unavailable")
    }))

  it.effect("prefers an OAuth refresh token over a service account", () =>
    Effect.gen(function*() {
      const credential = yield* resolve({
        GOOGLE_SERVICE_ACCOUNT_KEY: key.json,
        GOOGLE_OAUTH_CLIENT_ID: " client-id ",
        GOOGLE_OAUTH_CLIENT_SECRET: "client-secret",
        GOOGLE_OAUTH_REFRESH_TOKEN: "refresh-token"
      })
      expect(credential._tag).toBe("OAuthRefresh")
      if (credential._tag === "OAuthRefresh") {
        expect(credential.clientId).toBe("client-id")
        expect(Redacted.value(credential.clientSecret)).toBe("client-secret")
        expect(Redacted.value(credential.refreshToken)).toBe("refresh-token")
      }
    }))

  it.effect("requires the OAuth client alongside the refresh token", () =>
    Effect.gen(function*() {
      const error = yield* failure({ GOOGLE_OAUTH_REFRESH_TOKEN: "refresh-token" })
      expect(error.message).toContain("GOOGLE_OAUTH_CLIENT_ID and/or GOOGLE_OAUTH_CLIENT_SECRET are missing")
    }))

  it.effect("treats blank variables as unset", () =>
    Effect.gen(function*() {
      const error = yield* failure({ GOOGLE_OAUTH_REFRESH_TOKEN: "  ", GOOGLE_SERVICE_ACCOUNT_KEY: "" })
      expect(error.message).toContain("No Google credentials configured")
    }))
})

describe("Credential.readOnly / scope", () => {
  it.effect.each([
    { env: {}, readOnly: false, scope: Credential.SCOPE_FULL },
    { env: { GOOGLE_WORKSPACE_READ_ONLY: "1" }, readOnly: true, scope: Credential.SCOPE_READ_ONLY },
    { env: { GOOGLE_WORKSPACE_READ_ONLY: "true" }, readOnly: true, scope: Credential.SCOPE_READ_ONLY },
    { env: { GOOGLE_WORKSPACE_READ_ONLY: "false" }, readOnly: false, scope: Credential.SCOPE_FULL }
  ])("%p", ({ env, readOnly, scope }) =>
    Effect.gen(function*() {
      expect(yield* Credential.readOnly.pipe(withEnv(env))).toBe(readOnly)
      expect(yield* Credential.scope.pipe(withEnv(env))).toBe(scope)
    }))

  it.effect("rejects values that are not booleans", () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(Credential.readOnly.pipe(withEnv({ GOOGLE_WORKSPACE_READ_ONLY: "maybe" })))
      expect(error._tag).toBe("ConfigError")
    }))
})

describe("Credential.describe / identity", () => {
  const serviceAccount: Credential.ServiceAccount = {
    _tag: "ServiceAccount",
    clientEmail: "sa@p.iam.gserviceaccount.com",
    privateKey: Redacted.make("pem"),
    tokenUri: "https://oauth2.googleapis.com/token",
    subject: Option.none()
  }
  const impersonating = { ...serviceAccount, subject: Option.some("ari@acme.test") }
  const oauth: Credential.OAuthRefresh = {
    _tag: "OAuthRefresh",
    clientId: "cid",
    clientSecret: Redacted.make("s"),
    refreshToken: Redacted.make("r")
  }

  test("never leaks secrets", () => {
    expect(Credential.describe(serviceAccount)).not.toContain("pem")
    expect(Bun.inspect(oauth)).not.toContain("\"s\"")
    expect(Bun.inspect(oauth)).toContain("<redacted>")
  })

  test("names the identity to share files with", () => {
    expect(Credential.describe(serviceAccount)).toBe("service account sa@p.iam.gserviceaccount.com")
    expect(Credential.describe(impersonating)).toBe(
      "service account sa@p.iam.gserviceaccount.com impersonating ari@acme.test"
    )
    expect(Credential.describe(oauth)).toBe("OAuth user credential (client cid)")
    expect(Credential.identity(serviceAccount)).toBe("sa@p.iam.gserviceaccount.com")
    expect(Credential.identity(impersonating)).toBe("ari@acme.test")
    expect(Credential.identity(oauth)).toBe("the OAuth user")
  })
})
