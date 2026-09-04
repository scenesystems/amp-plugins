/**
 * Plugin activation and the production `layer`.
 *
 * `activate` is run against a fake Amp API to check what it registers. The production layer
 * (real HttpClient and FileSystem) is exercised with an explicit `ConfigProvider` for the cases that
 * end before any network request: missing or malformed credentials and the read-only switch.
 *
 * Effect's default `ConfigProvider` snapshots `process.env` once per process, so environment
 * variables are supplied through `ConfigProvider.fromEnvRecord` rather than by mutating `process.env`.
 */
import { describe, it } from "@effect/vitest"
import * as Assert from "@effect/vitest/utils"
import { Runtime, Tool } from "@scenesystems/amp-plugin-core"
import { PluginApi } from "@scenesystems/amp-plugin-testing"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import activate, { checkCredentials, description, layer } from "../src/index.ts"
import * as Tools from "../src/Tools.ts"

const NO_CREDENTIALS = [
  "Error: Google credential error: No Google credentials configured.",
  "Set one of:",
  "  - GOOGLE_SERVICE_ACCOUNT_KEY (service account JSON) as an Amp workspace secret, or",
  "  - GOOGLE_OAUTH_CLIENT_ID + GOOGLE_OAUTH_CLIENT_SECRET + GOOGLE_OAUTH_REFRESH_TOKEN as personal secrets.",
  "Hint: See the google-workspace skill (reference/setup.md) for setup steps."
].join("\n")

describe("plugin activation", () => {
  it.effect("registers nine tools, one command, the skill, and a disposer, then logs", () =>
    Effect.gen(function*() {
      const amp = PluginApi.make()
      activate(amp.api)
      yield* Effect.addFinalizer(() => Effect.promise(() => amp.dispose()))
      Assert.deepStrictEqual(amp.tools.map((t) => t.name), Tools.all.map((t) => t.name))
      Assert.deepStrictEqual(
        amp.commands.map((c) => ({ id: c.id, options: c.options })),
        [{
          id: "check-credentials",
          options: {
            title: "check Google credentials",
            category: "google-workspace",
            description: "Verify the Google service account / OAuth credentials and show the identity Drive sees."
          }
        }]
      )
      Assert.deepStrictEqual(amp.skills, [{ path: "skills/google-workspace" }])
      Assert.strictEqual(amp.disposers(), 1)
      Assert.deepStrictEqual(amp.logs, [["google-workspace plugin loaded"]])
    }))
})

describe("production layer", () => {
  /** The production layer with `env` as its only configuration source, registered like `activate` does. */
  const production = (env: Record<string, string>) =>
    Effect.gen(function*() {
      const amp = PluginApi.make()
      const runtime = Runtime.make(
        amp.api,
        layer.pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(env))))
      )
      Tool.registerAll(amp.api, runtime, Tools.all)
      yield* Effect.addFinalizer(() => Effect.promise(() => amp.dispose()))
      return {
        call: (name: string, input: Record<string, unknown>) =>
          Effect.promise(() => amp.tool(name).execute(input, amp.toolContext)),
        checkCredentials: Effect.promise(() => runtime.runPromise(checkCredentials))
      }
    })

  it.effect("gdrive_whoami explains missing credentials", () =>
    Effect.gen(function*() {
      const p = yield* production({})
      Assert.strictEqual(yield* p.call("gdrive_whoami", {}), NO_CREDENTIALS)
    }))

  it.effect("the check-credentials command body renders the same explanation", () =>
    Effect.gen(function*() {
      const p = yield* production({})
      Assert.strictEqual(yield* p.checkCredentials, NO_CREDENTIALS)
    }))

  it.effect("a malformed GOOGLE_SERVICE_ACCOUNT_KEY is reported before any network call", () =>
    Effect.gen(function*() {
      const p = yield* production({ GOOGLE_SERVICE_ACCOUNT_KEY: "{\"client_email\": \"missing private key\"}" })
      Assert.strictEqual(
        yield* p.checkCredentials,
        "Error: Google credential error: Service account key is not valid JSON with \"client_email\" and \"private_key\".\nHint: Store the downloaded key file verbatim: amp secrets set --workspace GOOGLE_SERVICE_ACCOUNT_KEY --secret --data-file key.json"
      )
    }))

  it.effect("a missing key file is reported with its path through the real FileSystem", () =>
    Effect.gen(function*() {
      const p = yield* production({ GOOGLE_SERVICE_ACCOUNT_KEY_FILE: "/nonexistent/key.json" })
      Assert.strictEqual(
        yield* p.call("gdrive_whoami", {}),
        "Error: Google credential error: Cannot read service account key file /nonexistent/key.json: NotFound: FileSystem.readFile (/nonexistent/key.json)"
      )
    }))

  it.effect("a bad GOOGLE_WORKSPACE_READ_ONLY value is reported with the accepted spellings", () =>
    Effect.gen(function*() {
      const p = yield* production({ GOOGLE_WORKSPACE_READ_ONLY: "maybe" })
      Assert.strictEqual(
        yield* p.call("gdocs_append", { file: "1DocVision0000000000", text: "x" }),
        "Error: Google credential error: Invalid Google credential configuration: SchemaError(Expected \"true\" | \"yes\" | \"on\" | \"1\" | \"y\" | \"false\" | \"no\" | \"off\" | \"0\" | \"n\"\n  at [\"GOOGLE_WORKSPACE_READ_ONLY\"])"
      )
    }))

  it.effect("GOOGLE_WORKSPACE_READ_ONLY=1 disables write tools before credentials are needed", () =>
    Effect.gen(function*() {
      const p = yield* production({ GOOGLE_WORKSPACE_READ_ONLY: "1" })
      Assert.strictEqual(
        yield* p.call("gsheets_write", { file: "1SheetRoadmap00000000", range: "A1", values: [[1]] }),
        "Error: Write tools are disabled because GOOGLE_WORKSPACE_READ_ONLY is set.\nHint: Unset it (and run `amp orb restart-processes` in an orb) to enable writes."
      )
    }))
})

describe("plugin description", () => {
  it("is the literal Amp reads statically from index.ts, at most 300 characters", () => {
    const source = readFileSync(fileURLToPath(new URL("../src/index.ts", import.meta.url)), "utf8")
    const literal = /^export const description =\s*"((?:[^"\\]|\\.)*)"$/m.exec(source)?.[1]
    Assert.assertDefined(literal)
    Assert.strictEqual(JSON.parse(`"${literal}"`), description)
    Assert.assertTrue(description.length <= 300, `description is ${description.length} characters`)
  })
})
