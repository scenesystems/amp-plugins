/** Distribution smoke test for the built Google Workspace plugin under Bun. */
import type { PluginAPI } from "@ampcode/plugin"
import * as PluginApi from "@scenesystems/amp-plugin-testing/PluginApi"
import { describe, expect, test } from "bun:test"
import * as Arr from "effect/Array"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Record from "effect/Record"
import * as Schema from "effect/Schema"
import { existsSync, readFileSync } from "node:fs"
import { builtinModules } from "node:module"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dir, "..")
const dist = join(root, "dist/google-workspace")
const bundlePath = join(dist, "index.js")

expect(existsSync(bundlePath), `${bundlePath} is missing; run \`bun run build\` before \`bun run test:bundle\`.`).toBe(
  true
)

// Effect's default ConfigProvider snapshots process.env on first read, so arrange it before loading.
Arr.forEach(Record.keys({ ...process.env }), (name) => {
  if (name.startsWith("GOOGLE_")) delete process.env[name]
})
process.env["GOOGLE_SERVICE_ACCOUNT_KEY_FILE"] = "/nonexistent/amp-plugins-bundle-test/key.json"

const source = readFileSync(bundlePath, "utf8")
/** A plugin's `activate` as Amp calls it; the fake API is typed by the same `@ampcode/plugin` contract. */
const Activate = Schema.declare(
  (u): u is (api: PluginAPI) => void => Predicate.isFunction(u),
  { title: "activate(api: PluginAPI): void" }
)
const Bundle = Schema.Struct({ default: Activate, description: Schema.String })
const loadBundle = Effect.promise(() => import(bundlePath)).pipe(Effect.map(Schema.decodeUnknownSync(Bundle)))

describe("dist/google-workspace/index.js", () => {
  test("exports the description as the single literal Amp reads statically", () =>
    Effect.runPromise(Effect.gen(function*() {
      const bundle = yield* loadBundle
      const literals = Arr.fromIterable(source.matchAll(/^export const description = "((?:[^"\\]|\\.)*)";$/gm))
      expect(literals).toHaveLength(1)
      const literal = Option.getOrThrow(Arr.get(literals, 0))
      const captured = Option.getOrThrow(Arr.get(literal, 1))
      const capturedString = yield* Schema.decodeEffect(Schema.String)(captured)
      const description = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.String))(`"${capturedString}"`)
      expect(description).toBe(bundle.description)
      expect(bundle.description.length).toBeLessThanOrEqual(300)
      expect(source).not.toMatch(/^var description =/m)
    })))

  test("inlines every dependency; only runtime builtins are imported (and never @ampcode/plugin)", () => {
    const imports = Arr.map(Arr.fromIterable(source.matchAll(/^import .* from "([^"]+)";?$/gm)), (match) => {
      return Option.getOrThrow(Arr.get(match, 1))
    })
    const isBuiltin = (name: string) =>
      name === "bun" || name.startsWith("bun:") || builtinModules.includes(name.replace(/^node:/, ""))
    expect(imports.filter((name) => !isBuiltin(name))).toEqual([])
    expect(source).not.toContain("@ampcode/plugin")
  })

  test("ships the skill directory and README next to the bundle", () => {
    expect(existsSync(join(dist, "skills/google-workspace/SKILL.md"))).toBe(true)
    expect(existsSync(join(dist, "skills/google-workspace/reference/setup.md"))).toBe(true)
    expect(existsSync(join(dist, "README.md"))).toBe(true)
  })

  test("records its provenance in BUILD: plugin, release, commit, build time, source URL", () => {
    const stamp = readFileSync(join(dist, "BUILD"), "utf8")
    const fields = Record.fromEntries(
      stamp.trimEnd().split("\n").map((line): [string, string] => {
        const index = line.indexOf(": ")
        return [line.slice(0, index), line.slice(index + 2)]
      })
    )
    const field = (key: string): string => {
      return Option.getOrThrow(Record.get(fields, key))
    }
    expect(Record.keys(fields)).toEqual(["plugin", "release", "commit", "built", "source"])
    expect(field("plugin")).toBe("google-workspace")
    expect(field("release")).toMatch(/^(unreleased|v\d{4}\.\d{2}\.\d{2}(\.\d+)?)$/)
    expect(field("commit")).toMatch(/^([0-9a-f]{7}(-dirty)?|unknown)$/)
    expect(DateTime.formatIso(Schema.decodeSync(Schema.DateTimeUtcFromString)(field("built")))).toBe(
      field("built")
    )
    expect(field("source")).toBe(
      `https://github.com/scenesystems/amp-plugins/tree/${
        field("commit").replace(/-dirty$/, "")
      }/plugins/google-workspace`
    )
  })

  test("activates: nine tools, the command, the skill, one disposer", () =>
    Effect.runPromise(Effect.gen(function*() {
      const bundle = yield* loadBundle
      const amp = PluginApi.make()
      bundle.default(amp.api)
      expect(amp.tools.map((t) => t.name)).toEqual([
        "gdrive_whoami",
        "gdrive_search",
        "gdrive_file_info",
        "gdocs_read",
        "gsheets_read",
        "gdrive_comments",
        "gsheets_write",
        "gdocs_append",
        "gdrive_comment_add"
      ])
      expect(amp.commands.map((c) => c.id)).toEqual(["check-credentials"])
      expect(amp.skills).toEqual([{ path: "skills/google-workspace" }])
      expect(amp.disposers()).toBe(1)
      expect(amp.logs).toEqual([["google-workspace plugin loaded"]])
      yield* amp.dispose
    })))

  test("runs a tool on Bun: config, file system, and error rendering work in the bundle", () =>
    Effect.runPromise(Effect.gen(function*() {
      const bundle = yield* loadBundle
      const amp = PluginApi.make()
      bundle.default(amp.api)
      const out = yield* amp.execute("gdrive_whoami", {})
      expect(out).toBe(
        "Error: Google credential error: Cannot read service account key file /nonexistent/amp-plugins-bundle-test/key.json: NotFound: FileSystem.readFile (/nonexistent/amp-plugins-bundle-test/key.json)"
      )
      yield* amp.dispose
    })))
})
