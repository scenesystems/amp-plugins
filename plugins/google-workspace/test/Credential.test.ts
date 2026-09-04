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
import * as Record from "effect/Record"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as TestSchema from "effect/testing/TestSchema"
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
const KeyFile = Schema.Struct({
  client_email: Schema.String,
  private_key: Schema.String,
  token_uri: Schema.optional(Schema.String),
  type: Schema.optional(Schema.String)
})
const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const encodeKeyFile = Schema.encodeSync(Schema.fromJsonString(KeyFile))
const KEY_JSON = encodeKeyFile({ type: "service_account", token_uri: "https://oauth2.googleapis.com/token", ...KEY })

const serviceAccount = (subject: Option.Option<string>, tokenUri = "https://oauth2.googleapis.com/token") =>
  Credential.Credential.ServiceAccount({
    clientEmail: KEY.client_email,
    privateKey: Redacted.make(KEY.private_key),
    tokenUri,
    subject
  })

const PROVIDER = "projects/123456789012/locations/global/workloadIdentityPools/amp-orbs/providers/amp"
const SA_EMAIL = "amp-google-workspace@example-project.iam.gserviceaccount.com"

const workloadIdentity = (
  subject: Option.Option<string>,
  subjectToken: Credential.SubjectTokenSource = Credential.SubjectTokenSource.AmpOrb()
) =>
  Credential.Credential.WorkloadIdentity({
    provider: PROVIDER,
    serviceAccountEmail: SA_EMAIL,
    subject,
    subjectToken
  })

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
      Effect.fromOption(Record.get(contents, path), () =>
        PlatformError.systemError({
          _tag: "NotFound",
          module: "FileSystem",
          method: "readFileString",
          pathOrDescriptor: path
        }))
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
        const exit = yield* resolve({ GOOGLE_SERVICE_ACCOUNT_KEY: encodeKeyFile(KEY) })
        ExitAssert.assertSucceeds(exit, serviceAccount(Option.none()))
      }))

    it.effect("keeps the key's own token_uri", () =>
      Effect.gen(function*() {
        const custom = encodeKeyFile({ ...KEY, token_uri: "https://oauth2.example.test/token" })
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
        const other = encodeKeyFile({ ...KEY, client_email: "other@example-project.iam.gserviceaccount.com" })
        const exit = yield* resolve(
          { GOOGLE_SERVICE_ACCOUNT_KEY_FILE: "/a.json", GOOGLE_APPLICATION_CREDENTIALS: "/b.json" },
          { fs: files({ "/a.json": KEY_JSON, "/b.json": other }) }
        )
        ExitAssert.assertSucceeds(exit, serviceAccount(Option.none()))
      }))

    it.effect("prefers the inline key over a key file and never touches the file system", () =>
      Effect.gen(function*() {
        const exit = yield* resolve(
          { GOOGLE_SERVICE_ACCOUNT_KEY: encodeKeyFile(KEY), GOOGLE_SERVICE_ACCOUNT_KEY_FILE: "/a.json" },
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
      { name: "JSON without private_key", key: toJson({ client_email: KEY.client_email }) },
      { name: "JSON without client_email", key: toJson({ private_key: KEY.private_key }) },
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
          GOOGLE_SERVICE_ACCOUNT_KEY: encodeKeyFile(KEY),
          GOOGLE_IMPERSONATE_USER: "ari@scenesystems.io"
        })
        ExitAssert.assertSucceeds(exit, serviceAccount(Option.some("ari@scenesystems.io")))
      }))

    it.effect.each(["amp-user", "AMP-USER", " Amp-User "])(
      "impersonates the signed-in Amp user when GOOGLE_IMPERSONATE_USER is %s",
      (value) =>
        Effect.gen(function*() {
          const exit = yield* resolve(
            { GOOGLE_SERVICE_ACCOUNT_KEY: encodeKeyFile(KEY), GOOGLE_IMPERSONATE_USER: value },
            { ampUserEmail: Option.some("ari@scenesystems.io") }
          )
          ExitAssert.assertSucceeds(exit, serviceAccount(Option.some("ari@scenesystems.io")))
        })
    )

    it.effect("fails when amp-user impersonation is requested but Amp has no signed-in email", () =>
      Effect.gen(function*() {
        const exit = yield* resolve({
          GOOGLE_SERVICE_ACCOUNT_KEY: encodeKeyFile(KEY),
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
          Credential.Credential.OAuthRefresh({
            clientId: "client-id.apps.googleusercontent.com",
            clientSecret: Redacted.make("GOCSPX-secret"),
            refreshToken: Redacted.make("1//refresh")
          })
        )
      }))

    it.effect("wins over a service account when both are configured", () =>
      Effect.gen(function*() {
        const exit = yield* resolve({
          GOOGLE_SERVICE_ACCOUNT_KEY: encodeKeyFile(KEY),
          GOOGLE_OAUTH_CLIENT_ID: "id",
          GOOGLE_OAUTH_CLIENT_SECRET: "secret",
          GOOGLE_OAUTH_REFRESH_TOKEN: "token"
        })
        ExitAssert.assertSucceeds(
          exit,
          Credential.Credential.OAuthRefresh({
            clientId: "id",
            clientSecret: Redacted.make("secret"),
            refreshToken: Redacted.make("token")
          })
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
          GOOGLE_SERVICE_ACCOUNT_KEY: encodeKeyFile(KEY)
        })
        ExitAssert.assertSucceeds(exit, serviceAccount(Option.none()))
      }))
  })

  describe("workload identity", () => {
    const wifEnv = {
      GOOGLE_WORKLOAD_IDENTITY_PROVIDER: PROVIDER,
      GOOGLE_SERVICE_ACCOUNT_EMAIL: SA_EMAIL
    }

    it.effect("resolves the provider and service account, sourcing the token from the orb by default", () =>
      Effect.gen(function*() {
        const exit = yield* resolve(wifEnv)
        ExitAssert.assertSucceeds(exit, workloadIdentity(Option.none()))
      }))

    it.effect("reads the OIDC token from GOOGLE_WORKLOAD_IDENTITY_TOKEN_FILE when set", () =>
      Effect.gen(function*() {
        const exit = yield* resolve({ ...wifEnv, GOOGLE_WORKLOAD_IDENTITY_TOKEN_FILE: "/var/run/oidc/token" })
        ExitAssert.assertSucceeds(
          exit,
          workloadIdentity(Option.none(), { _tag: "File", path: "/var/run/oidc/token" })
        )
      }))

    it.effect("does not touch the file system: the token file is read per exchange, not at resolution", () =>
      Effect.gen(function*() {
        const exit = yield* resolve(
          { ...wifEnv, GOOGLE_WORKLOAD_IDENTITY_TOKEN_FILE: "/var/run/oidc/token" },
          { fs: FileSystem.layerNoop({ readFileString: () => Effect.die("the file system must not be consulted") }) }
        )
        ExitAssert.assertSucceeds(
          exit,
          workloadIdentity(Option.none(), { _tag: "File", path: "/var/run/oidc/token" })
        )
      }))

    it.effect.each([
      { form: "the STS audience form", value: `//iam.googleapis.com/${PROVIDER}` },
      { form: "the OIDC audience form", value: `https://iam.googleapis.com/${PROVIDER}` },
      { form: "surrounding whitespace", value: `  ${PROVIDER}\n` }
    ])("canonicalises a provider copied with $form", ({ value }) =>
      Effect.gen(function*() {
        const exit = yield* resolve({ ...wifEnv, GOOGLE_WORKLOAD_IDENTITY_PROVIDER: value })
        ExitAssert.assertSucceeds(exit, workloadIdentity(Option.none()))
      }))

    it.effect.each([
      { name: "a project id instead of a number", value: PROVIDER.replace("123456789012", "example-project") },
      {
        name: "a pool without a provider",
        value: "projects/123456789012/locations/global/workloadIdentityPools/amp-orbs"
      },
      { name: "a regional location", value: PROVIDER.replace("/global/", "/us-central1/") },
      { name: "an uppercase pool id", value: PROVIDER.replace("amp-orbs", "Amp-Orbs") },
      { name: "a bare pool id", value: "amp-orbs" }
    ])(
      "rejects a provider that is $name with the gcloud command that prints the right one",
      ({ value }) =>
        Effect.gen(function*() {
          const exit = yield* resolve({ ...wifEnv, GOOGLE_WORKLOAD_IDENTITY_PROVIDER: value })
          ExitAssert.assertFails(
            exit,
            new Credential.CredentialError({
              message:
                `GOOGLE_WORKLOAD_IDENTITY_PROVIDER must look like projects/<project-number>/locations/global/workloadIdentityPools/<pool-id>/providers/<provider-id>, got "${value}".`,
              hint:
                "Copy the `name` field from: gcloud iam workload-identity-pools providers describe <provider> --location global --workload-identity-pool <pool>"
            })
          )
        })
    )

    it.effect.each([
      { name: "a person's address", value: "ari@scenesystems.io" },
      { name: "a service account's unique id", value: "123456789012345678901" },
      { name: "a gserviceaccount.com domain without a local part", value: "@example-project.iam.gserviceaccount.com" }
    ])(
      "rejects $name as the service account and explains how to act as a person",
      ({ value }) =>
        Effect.gen(function*() {
          const exit = yield* resolve({ ...wifEnv, GOOGLE_SERVICE_ACCOUNT_EMAIL: value })
          ExitAssert.assertFails(
            exit,
            new Credential.CredentialError({
              message:
                `GOOGLE_SERVICE_ACCOUNT_EMAIL must be a service account (…@<project>.iam.gserviceaccount.com), got "${value}".`,
              hint:
                "Workload identity impersonates a service account; to act as a person set GOOGLE_IMPERSONATE_USER as well."
            })
          )
        })
    )

    it.effect("accepts the default-compute service account form as well", () =>
      Effect.gen(function*() {
        const email = "123456789012-compute@developer.gserviceaccount.com"
        const exit = yield* resolve({ ...wifEnv, GOOGLE_SERVICE_ACCOUNT_EMAIL: email })
        ExitAssert.assertSucceeds(exit, { ...workloadIdentity(Option.none()), serviceAccountEmail: email })
      }))

    it.effect.each([
      {
        set: "GOOGLE_WORKLOAD_IDENTITY_PROVIDER",
        missing: "GOOGLE_SERVICE_ACCOUNT_EMAIL",
        record: { GOOGLE_WORKLOAD_IDENTITY_PROVIDER: PROVIDER }
      },
      {
        set: "GOOGLE_SERVICE_ACCOUNT_EMAIL",
        missing: "GOOGLE_WORKLOAD_IDENTITY_PROVIDER",
        record: { GOOGLE_SERVICE_ACCOUNT_EMAIL: SA_EMAIL }
      },
      {
        set: "GOOGLE_SERVICE_ACCOUNT_EMAIL",
        missing: "GOOGLE_WORKLOAD_IDENTITY_PROVIDER",
        record: { GOOGLE_SERVICE_ACCOUNT_EMAIL: SA_EMAIL, GOOGLE_WORKLOAD_IDENTITY_PROVIDER: "  " }
      }
    ])(
      "fails when $set is set but $missing is missing, even with a key configured",
      ({ missing, record, set }) =>
        Effect.gen(function*() {
          const exit = yield* resolve({ ...record, GOOGLE_SERVICE_ACCOUNT_KEY: encodeKeyFile(KEY) })
          ExitAssert.assertFails(
            exit,
            new Credential.CredentialError({
              message: `${set} is set but ${missing} is missing; workload identity needs both.`,
              hint: SETUP_HINT
            })
          )
        })
    )

    it.effect("wins over a service account key when both are configured", () =>
      Effect.gen(function*() {
        const exit = yield* resolve({ ...wifEnv, GOOGLE_SERVICE_ACCOUNT_KEY: encodeKeyFile(KEY) })
        ExitAssert.assertSucceeds(exit, workloadIdentity(Option.none()))
      }))

    it.effect("loses to an OAuth refresh token, whose variables are then the only ones validated", () =>
      Effect.gen(function*() {
        const exit = yield* resolve({
          ...wifEnv,
          GOOGLE_WORKLOAD_IDENTITY_PROVIDER: "not-a-provider",
          GOOGLE_OAUTH_CLIENT_ID: "id",
          GOOGLE_OAUTH_CLIENT_SECRET: "secret",
          GOOGLE_OAUTH_REFRESH_TOKEN: "token"
        })
        ExitAssert.assertSucceeds(
          exit,
          Credential.Credential.OAuthRefresh({
            clientId: "id",
            clientSecret: Redacted.make("secret"),
            refreshToken: Redacted.make("token")
          })
        )
      }))

    it.effect("impersonates the configured email through domain-wide delegation", () =>
      Effect.gen(function*() {
        const exit = yield* resolve({ ...wifEnv, GOOGLE_IMPERSONATE_USER: "ari@scenesystems.io" })
        ExitAssert.assertSucceeds(exit, workloadIdentity(Option.some("ari@scenesystems.io")))
      }))

    it.effect("impersonates the signed-in Amp user for GOOGLE_IMPERSONATE_USER=amp-user", () =>
      Effect.gen(function*() {
        const exit = yield* resolve(
          { ...wifEnv, GOOGLE_IMPERSONATE_USER: "amp-user" },
          { ampUserEmail: Option.some("ari@scenesystems.io") }
        )
        ExitAssert.assertSucceeds(exit, workloadIdentity(Option.some("ari@scenesystems.io")))
      }))

    it.effect("fails amp-user impersonation without a signed-in email", () =>
      Effect.gen(function*() {
        const exit = yield* resolve({ ...wifEnv, GOOGLE_IMPERSONATE_USER: "amp-user" })
        ExitAssert.assertFails(
          exit,
          new Credential.CredentialError({
            message: "GOOGLE_IMPERSONATE_USER=amp-user but the Amp user email is unavailable (not signed in?)."
          })
        )
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
          GOOGLE_OAUTH_REFRESH_TOKEN: "\n",
          GOOGLE_WORKLOAD_IDENTITY_PROVIDER: "\t",
          GOOGLE_SERVICE_ACCOUNT_EMAIL: ""
        }
      },
      { name: "only an impersonation target", record: { GOOGLE_IMPERSONATE_USER: "ari@scenesystems.io" } },
      {
        name: "only a token file",
        record: { GOOGLE_WORKLOAD_IDENTITY_TOKEN_FILE: "/var/run/oidc/token" }
      }
    ])("fails with the setup instructions given $name", ({ record }) =>
      Effect.gen(function*() {
        const exit = yield* resolve(record)
        ExitAssert.assertFails(
          exit,
          new Credential.CredentialError({
            message: [
              "No Google credentials configured.",
              "Set one of:",
              "  - GOOGLE_WORKLOAD_IDENTITY_PROVIDER + GOOGLE_SERVICE_ACCOUNT_EMAIL (keyless; Amp workspace variables), or",
              "  - GOOGLE_OAUTH_CLIENT_ID + GOOGLE_OAUTH_CLIENT_SECRET + GOOGLE_OAUTH_REFRESH_TOKEN (acts as you; personal secrets), or",
              "  - GOOGLE_SERVICE_ACCOUNT_KEY (service account JSON; Amp workspace secret)."
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

describe("Credential.ProviderName schema", () => {
  const asserts = new TestSchema.Asserts(Credential.ProviderName)

  it.effect("decodes the canonical name and both audience spellings to the canonical name", () =>
    Effect.gen(function*() {
      yield* Effect.promise(() => asserts.decoding().succeed(PROVIDER, PROVIDER))
      yield* Effect.promise(() => asserts.decoding().succeed(`//iam.googleapis.com/${PROVIDER}`, PROVIDER))
      yield* Effect.promise(() => asserts.decoding().succeed(`https://iam.googleapis.com/${PROVIDER}`, PROVIDER))
    }))

  it.effect("rejects other hosts and non-canonical shapes with the documented format", () =>
    Effect.gen(function*() {
      const expected =
        "Expected a string matching the RegExp ^projects\\/\\d+\\/locations\\/global\\/workloadIdentityPools\\/[a-z0-9-]+\\/providers\\/[a-z0-9-]+$"
      yield* Effect.promise(() => asserts.decoding().fail(`//sts.googleapis.com/${PROVIDER}`, expected))
      yield* Effect.promise(() => asserts.decoding().fail("amp-orbs", expected))
      yield* Effect.promise(() => asserts.decoding().fail(42, "Expected string"))
    }))

  it.effect("encodes the canonical name unchanged", () =>
    Effect.promise(() => asserts.encoding().succeed(PROVIDER, PROVIDER)))
})

describe("Credential.oidcAudience and stsAudience", () => {
  it("derive both audiences from the provider name", () => {
    const credential = workloadIdentity(Option.none())
    Assert.strictEqual(Credential.oidcAudience(credential), `https://iam.googleapis.com/${PROVIDER}`)
    Assert.strictEqual(Credential.stsAudience(credential), `//iam.googleapis.com/${PROVIDER}`)
  })
})

describe("Credential.describe, identity, and robotEmail", () => {
  it("names a plain service account and says files must be shared with it", () => {
    const credential = serviceAccount(Option.none())
    Assert.strictEqual(Credential.describe(credential), `service account ${KEY.client_email}`)
    Assert.strictEqual(Credential.identity(credential), KEY.client_email)
    Assert.assertSome(Credential.robotEmail(credential), KEY.client_email)
  })

  it("names the impersonated user for a delegated service account", () => {
    const credential = serviceAccount(Option.some("ari@scenesystems.io"))
    Assert.strictEqual(
      Credential.describe(credential),
      `service account ${KEY.client_email} impersonating ari@scenesystems.io`
    )
    Assert.strictEqual(Credential.identity(credential), "ari@scenesystems.io")
    Assert.assertNone(Credential.robotEmail(credential))
  })

  it("names the service account behind workload identity and says files must be shared with it", () => {
    const credential = workloadIdentity(Option.none())
    Assert.strictEqual(Credential.describe(credential), `workload identity for service account ${SA_EMAIL}`)
    Assert.strictEqual(Credential.identity(credential), SA_EMAIL)
    Assert.assertSome(Credential.robotEmail(credential), SA_EMAIL)
  })

  it("names the impersonated user for delegated workload identity", () => {
    const credential = workloadIdentity(Option.some("ari@scenesystems.io"))
    Assert.strictEqual(
      Credential.describe(credential),
      `workload identity for service account ${SA_EMAIL} impersonating ari@scenesystems.io`
    )
    Assert.strictEqual(Credential.identity(credential), "ari@scenesystems.io")
    Assert.assertNone(Credential.robotEmail(credential))
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
    Assert.assertNone(Credential.robotEmail(credential))
    ExitAssert.assertRedacted(credential, ["GOCSPX-secret", "1//refresh"])
  })

  it("keeps the private key out of every rendering of a service account", () => {
    ExitAssert.assertRedacted(serviceAccount(Option.none()), [
      KEY.private_key,
      "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7"
    ])
  })
})
