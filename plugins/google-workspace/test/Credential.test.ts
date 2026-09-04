import * as BunFileSystem from "@effect/platform-bun/BunFileSystem"
import { describe, it } from "@effect/vitest"
import * as Assert from "@effect/vitest/utils"
import { Assert as ExitAssert } from "@scenesystems/amp-plugin-testing"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import type * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as PlatformError from "effect/PlatformError"
import * as Redacted from "effect/Redacted"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Credential from "../src/Credential.ts"

const SETUP_HINT = "See the google-workspace skill (reference/setup.md) for setup steps."

const KEY = {
  client_email: "robot@example-project.iam.gserviceaccount.com",
  private_key:
    "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7\n-----END PRIVATE KEY-----\n"
}
const KEY_JSON = JSON.stringify({ type: "service_account", token_uri: "https://oauth2.googleapis.com/token", ...KEY })

const serviceAccount = (subject: Option.Option<string>, tokenUri = "https://oauth2.googleapis.com/token") =>
  ({
    _tag: "ServiceAccount",
    clientEmail: KEY.client_email,
    privateKey: Redacted.make(KEY.private_key),
    tokenUri,
    subject
  }) satisfies Credential.ServiceAccount

/** No files exist: any read is a `NotFound` platform error, like an unmounted secret. */
const noFiles = FileSystem.layerNoop({
  readFileString: (path) =>
    Effect.fail(
      PlatformError.systemError({
        _tag: "NotFound",
        module: "FileSystem",
        method: "readFileString",
        pathOrDescriptor: path,
        description: "ENOENT: no such file or directory"
      })
    )
})

const files = (contents: Record<string, string>) =>
  FileSystem.layerNoop({
    readFileString: (path) =>
      path in contents
        ? Effect.succeed(contents[path]!)
        : Effect.fail(
          PlatformError.systemError({
            _tag: "NotFound",
            module: "FileSystem",
            method: "readFileString",
            pathOrDescriptor: path
          })
        )
  })

const env = (record: Record<string, string>) => ConfigProvider.layer(ConfigProvider.fromEnvRecord(record))

const resolve = (
  record: Record<string, string>,
  options: { readonly ampUserEmail?: Option.Option<string>; readonly fs?: Layer.Layer<FileSystem.FileSystem> } = {}
) =>
  Credential.resolve({ ampUserEmail: options.ampUserEmail ?? Option.none() }).pipe(
    Effect.provide([env(record), options.fs ?? noFiles]),
    Effect.exit
  )

describe("Credential.resolve", () => {
  describe("service account", () => {
    it.effect("resolves an inline key and defaults the token URI", () =>
      Effect.gen(function*() {
        const exit = yield* resolve({ GOOGLE_SERVICE_ACCOUNT_KEY: JSON.stringify(KEY) })
        ExitAssert.assertSucceeds(exit, serviceAccount(Option.none()))
      }))

    it.effect("keeps the key's own token_uri", () =>
      Effect.gen(function*() {
        const custom = JSON.stringify({ ...KEY, token_uri: "https://oauth2.example.test/token" })
        const exit = yield* resolve({ GOOGLE_SERVICE_ACCOUNT_KEY: custom })
        ExitAssert.assertSucceeds(exit, serviceAccount(Option.none(), "https://oauth2.example.test/token"))
      }))

    it.effect("reads the key from GOOGLE_SERVICE_ACCOUNT_KEY_FILE through the FileSystem service", () =>
      Effect.gen(function*() {
        const exit = yield* resolve(
          { GOOGLE_SERVICE_ACCOUNT_KEY_FILE: "/secrets/key.json" },
          { fs: files({ "/secrets/key.json": KEY_JSON }) }
        )
        ExitAssert.assertSucceeds(exit, serviceAccount(Option.none()))
      }))

    it.effect("falls back to GOOGLE_APPLICATION_CREDENTIALS when the plugin-specific path is unset", () =>
      Effect.gen(function*() {
        const exit = yield* resolve(
          { GOOGLE_APPLICATION_CREDENTIALS: "/adc/key.json" },
          { fs: files({ "/adc/key.json": KEY_JSON }) }
        )
        ExitAssert.assertSucceeds(exit, serviceAccount(Option.none()))
      }))

    it.effect("prefers GOOGLE_SERVICE_ACCOUNT_KEY_FILE over GOOGLE_APPLICATION_CREDENTIALS", () =>
      Effect.gen(function*() {
        const other = JSON.stringify({ ...KEY, client_email: "other@example-project.iam.gserviceaccount.com" })
        const exit = yield* resolve(
          { GOOGLE_SERVICE_ACCOUNT_KEY_FILE: "/a.json", GOOGLE_APPLICATION_CREDENTIALS: "/b.json" },
          { fs: files({ "/a.json": KEY_JSON, "/b.json": other }) }
        )
        ExitAssert.assertSucceeds(exit, serviceAccount(Option.none()))
      }))

    it.effect("prefers the inline key over a key file and never touches the file system", () =>
      Effect.gen(function*() {
        const exit = yield* resolve(
          { GOOGLE_SERVICE_ACCOUNT_KEY: JSON.stringify(KEY), GOOGLE_SERVICE_ACCOUNT_KEY_FILE: "/a.json" },
          { fs: FileSystem.layerNoop({ readFileString: () => Effect.die("the file system must not be consulted") }) }
        )
        ExitAssert.assertSucceeds(exit, serviceAccount(Option.none()))
      }))

    it.effect("reads a real key file with the Bun/Node file system layer", () =>
      Effect.gen(function*() {
        const dir = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(join(tmpdir(), "gw-credential-"))),
          (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true }))
        )
        const path = join(dir, "key.json")
        yield* Effect.promise(() => writeFile(path, KEY_JSON))
        const exit = yield* resolve({ GOOGLE_SERVICE_ACCOUNT_KEY_FILE: path }, { fs: BunFileSystem.layer })
        ExitAssert.assertSucceeds(exit, serviceAccount(Option.none()))
      }))

    it.effect("reports an unreadable key file with the platform error message", () =>
      Effect.gen(function*() {
        const exit = yield* resolve({ GOOGLE_SERVICE_ACCOUNT_KEY_FILE: "/nope/key.json" })
        ExitAssert.assertFails(
          exit,
          new Credential.CredentialError({
            message:
              "Cannot read service account key file /nope/key.json: NotFound: FileSystem.readFileString (/nope/key.json): ENOENT: no such file or directory"
          })
        )
      }))

    it.effect.each([
      { name: "not JSON", key: "-----BEGIN PRIVATE KEY-----" },
      { name: "JSON without private_key", key: JSON.stringify({ client_email: KEY.client_email }) },
      { name: "JSON without client_email", key: JSON.stringify({ private_key: KEY.private_key }) },
      { name: "a JSON array", key: "[]" }
    ])("rejects a key that is $name with the verbatim-storage hint", ({ key }) =>
      Effect.gen(function*() {
        const exit = yield* resolve({ GOOGLE_SERVICE_ACCOUNT_KEY: key })
        ExitAssert.assertFails(
          exit,
          new Credential.CredentialError({
            message: "Service account key is not valid JSON with \"client_email\" and \"private_key\".",
            hint:
              "Store the downloaded key file verbatim: amp secrets set --workspace GOOGLE_SERVICE_ACCOUNT_KEY --secret --data-file key.json"
          })
        )
      }))

    it.effect("impersonates the configured email", () =>
      Effect.gen(function*() {
        const exit = yield* resolve({
          GOOGLE_SERVICE_ACCOUNT_KEY: JSON.stringify(KEY),
          GOOGLE_IMPERSONATE_USER: "ari@scenesystems.io"
        })
        ExitAssert.assertSucceeds(exit, serviceAccount(Option.some("ari@scenesystems.io")))
      }))

    it.effect.each(["amp-user", "AMP-USER", " Amp-User "])(
      "impersonates the signed-in Amp user when GOOGLE_IMPERSONATE_USER is %s",
      (value) =>
        Effect.gen(function*() {
          const exit = yield* resolve(
            { GOOGLE_SERVICE_ACCOUNT_KEY: JSON.stringify(KEY), GOOGLE_IMPERSONATE_USER: value },
            { ampUserEmail: Option.some("ari@scenesystems.io") }
          )
          ExitAssert.assertSucceeds(exit, serviceAccount(Option.some("ari@scenesystems.io")))
        })
    )

    it.effect("fails when amp-user impersonation is requested but Amp has no signed-in email", () =>
      Effect.gen(function*() {
        const exit = yield* resolve({
          GOOGLE_SERVICE_ACCOUNT_KEY: JSON.stringify(KEY),
          GOOGLE_IMPERSONATE_USER: "amp-user"
        })
        ExitAssert.assertFails(
          exit,
          new Credential.CredentialError({
            message: "GOOGLE_IMPERSONATE_USER=amp-user but the Amp user email is unavailable (not signed in?)."
          })
        )
      }))
  })

  describe("OAuth refresh token", () => {
    it.effect("resolves the OAuth trio", () =>
      Effect.gen(function*() {
        const exit = yield* resolve({
          GOOGLE_OAUTH_CLIENT_ID: "client-id.apps.googleusercontent.com",
          GOOGLE_OAUTH_CLIENT_SECRET: "GOCSPX-secret",
          GOOGLE_OAUTH_REFRESH_TOKEN: "1//refresh"
        })
        ExitAssert.assertSucceeds(
          exit,
          {
            _tag: "OAuthRefresh",
            clientId: "client-id.apps.googleusercontent.com",
            clientSecret: Redacted.make("GOCSPX-secret"),
            refreshToken: Redacted.make("1//refresh")
          } satisfies Credential.OAuthRefresh
        )
      }))

    it.effect("wins over a service account when both are configured", () =>
      Effect.gen(function*() {
        const exit = yield* resolve({
          GOOGLE_SERVICE_ACCOUNT_KEY: JSON.stringify(KEY),
          GOOGLE_OAUTH_CLIENT_ID: "id",
          GOOGLE_OAUTH_CLIENT_SECRET: "secret",
          GOOGLE_OAUTH_REFRESH_TOKEN: "token"
        })
        ExitAssert.assertSucceeds(
          exit,
          {
            _tag: "OAuthRefresh",
            clientId: "id",
            clientSecret: Redacted.make("secret"),
            refreshToken: Redacted.make("token")
          } satisfies Credential.OAuthRefresh
        )
      }))

    it.effect.each([
      { name: "the client id", record: { GOOGLE_OAUTH_CLIENT_SECRET: "secret", GOOGLE_OAUTH_REFRESH_TOKEN: "token" } },
      { name: "the client secret", record: { GOOGLE_OAUTH_CLIENT_ID: "id", GOOGLE_OAUTH_REFRESH_TOKEN: "token" } },
      { name: "both client values", record: { GOOGLE_OAUTH_REFRESH_TOKEN: "token" } },
      {
        name: "a blank client id",
        record: {
          GOOGLE_OAUTH_CLIENT_ID: "   ",
          GOOGLE_OAUTH_CLIENT_SECRET: "secret",
          GOOGLE_OAUTH_REFRESH_TOKEN: "token"
        }
      }
    ])("fails when a refresh token is set but $name is missing", ({ record }) =>
      Effect.gen(function*() {
        const exit = yield* resolve(record)
        ExitAssert.assertFails(
          exit,
          new Credential.CredentialError({
            message:
              "GOOGLE_OAUTH_REFRESH_TOKEN is set but GOOGLE_OAUTH_CLIENT_ID and/or GOOGLE_OAUTH_CLIENT_SECRET are missing.",
            hint: SETUP_HINT
          })
        )
      }))

    it.effect("ignores a blank refresh token and falls through to the service account", () =>
      Effect.gen(function*() {
        const exit = yield* resolve({
          GOOGLE_OAUTH_REFRESH_TOKEN: "  ",
          GOOGLE_SERVICE_ACCOUNT_KEY: JSON.stringify(KEY)
        })
        ExitAssert.assertSucceeds(exit, serviceAccount(Option.none()))
      }))
  })

  describe("nothing configured", () => {
    it.effect.each([
      { name: "an empty environment", record: {} },
      {
        name: "only blank values",
        record: {
          GOOGLE_SERVICE_ACCOUNT_KEY: "",
          GOOGLE_SERVICE_ACCOUNT_KEY_FILE: " ",
          GOOGLE_OAUTH_REFRESH_TOKEN: "\n"
        }
      },
      { name: "only an impersonation target", record: { GOOGLE_IMPERSONATE_USER: "ari@scenesystems.io" } }
    ])("fails with the setup instructions given $name", ({ record }) =>
      Effect.gen(function*() {
        const exit = yield* resolve(record)
        ExitAssert.assertFails(
          exit,
          new Credential.CredentialError({
            message: [
              "No Google credentials configured.",
              "Set one of:",
              "  - GOOGLE_SERVICE_ACCOUNT_KEY (service account JSON) as an Amp workspace secret, or",
              "  - GOOGLE_OAUTH_CLIENT_ID + GOOGLE_OAUTH_CLIENT_SECRET + GOOGLE_OAUTH_REFRESH_TOKEN as personal secrets."
            ].join("\n"),
            hint: SETUP_HINT
          })
        )
      }))
  })

  describe("configuration source failures", () => {
    it.effect("wraps a failing ConfigProvider as a configuration error", () =>
      Effect.gen(function*() {
        const unreachable = ConfigProvider.make((path) =>
          Effect.fail(new ConfigProvider.SourceError({ message: `vault unreachable at ${path.join(".")}` }))
        )
        const exit = yield* Credential.resolve({ ampUserEmail: Option.none() }).pipe(
          Effect.provide([ConfigProvider.layer(unreachable), noFiles]),
          Effect.exit
        )
        ExitAssert.assertFails(
          exit,
          new Credential.CredentialError({
            message:
              "Invalid Google credential configuration: SourceError: vault unreachable at GOOGLE_OAUTH_REFRESH_TOKEN",
            hint: SETUP_HINT
          })
        )
      }))
  })
})

describe("Credential.readOnly and scope", () => {
  const readOnlyWith = (record: Record<string, string>) =>
    Credential.readOnly.pipe(Effect.provide(env(record)), Effect.exit)
  const scopeWith = (record: Record<string, string>) => Credential.scope.pipe(Effect.provide(env(record)), Effect.exit)

  it.effect.each([
    { value: "1", readOnly: true },
    { value: "true", readOnly: true },
    { value: "yes", readOnly: true },
    { value: " on ", readOnly: true },
    { value: "0", readOnly: false },
    { value: "false", readOnly: false },
    { value: "", readOnly: false },
    { value: "   ", readOnly: false }
  ])("GOOGLE_WORKSPACE_READ_ONLY=$value → readOnly $readOnly", ({ readOnly, value }) =>
    Effect.gen(function*() {
      ExitAssert.assertSucceeds(yield* readOnlyWith({ GOOGLE_WORKSPACE_READ_ONLY: value }), readOnly)
      ExitAssert.assertSucceeds(
        yield* scopeWith({ GOOGLE_WORKSPACE_READ_ONLY: value }),
        readOnly ? Credential.SCOPE_READ_ONLY : Credential.SCOPE_FULL
      )
    }))

  it.effect("defaults to writable with the full Drive scope when unset", () =>
    Effect.gen(function*() {
      ExitAssert.assertSucceeds(yield* readOnlyWith({}), false)
      ExitAssert.assertSucceeds(yield* scopeWith({}), "https://www.googleapis.com/auth/drive")
    }))

  it.effect("rejects a value that is not a boolean word, naming the variable", () =>
    Effect.gen(function*() {
      const exit = yield* readOnlyWith({ GOOGLE_WORKSPACE_READ_ONLY: "maybe" })
      const error = ExitAssert.failureOf(exit)
      Assert.strictEqual(error._tag, "ConfigError")
      Assert.strictEqual(
        error.message,
        "SchemaError(Expected \"true\" | \"yes\" | \"on\" | \"1\" | \"y\" | \"false\" | \"no\" | \"off\" | \"0\" | \"n\"\n  at [\"GOOGLE_WORKSPACE_READ_ONLY\"])"
      )
    }))
})

describe("Credential.describe and identity", () => {
  it("names a plain service account and says files must be shared with it", () => {
    const credential = serviceAccount(Option.none())
    Assert.strictEqual(Credential.describe(credential), `service account ${KEY.client_email}`)
    Assert.strictEqual(Credential.identity(credential), KEY.client_email)
  })

  it("names the impersonated user for a delegated service account", () => {
    const credential = serviceAccount(Option.some("ari@scenesystems.io"))
    Assert.strictEqual(
      Credential.describe(credential),
      `service account ${KEY.client_email} impersonating ari@scenesystems.io`
    )
    Assert.strictEqual(Credential.identity(credential), "ari@scenesystems.io")
  })

  it("names the OAuth client and never its secrets", () => {
    const credential: Credential.OAuthRefresh = {
      _tag: "OAuthRefresh",
      clientId: "client-id",
      clientSecret: Redacted.make("GOCSPX-secret"),
      refreshToken: Redacted.make("1//refresh")
    }
    Assert.strictEqual(Credential.describe(credential), "OAuth user credential (client client-id)")
    Assert.strictEqual(Credential.identity(credential), "the OAuth user")
    ExitAssert.assertRedacted(credential, ["GOCSPX-secret", "1//refresh"])
  })

  it("keeps the private key out of every rendering of a service account", () => {
    ExitAssert.assertRedacted(serviceAccount(Option.none()), [
      KEY.private_key,
      "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7"
    ])
  })
})
