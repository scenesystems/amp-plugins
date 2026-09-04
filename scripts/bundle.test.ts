/**
 * Distribution smoke test: loads the built `dist/google-workspace/index.js` under Bun, the runtime Amp
 * uses for plugins, and checks that the bundle is what Amp expects.
 *
 * This is deliberately a distribution test, not a behaviour test: behaviour is covered by the Vitest
 * suites against source. What only the bundle can prove is that (1) the static `description` literal
 * survived `scripts/build.ts`'s rewrite, (2) the inlined Effect runtime, Bun file system, and config
 * reading work under Bun, and (3) the skill directory ships with it.
 *
 * Run `bun run build` first; `bun run test:bundle` does both.
 */
import * as PluginApi from "@scenesystems/amp-plugin-testing/PluginApi"
import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { builtinModules } from "node:module"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dir, "..")
const dist = join(root, "dist/google-workspace")
const bundlePath = join(dist, "index.js")

if (!existsSync(bundlePath)) {
  throw new Error(`${bundlePath} is missing; run \`bun run build\` before \`bun run test:bundle\`.`)
}

// Effect's default ConfigProvider snapshots process.env on first read, so the environment must be
// arranged before the bundle runs any tool. A key file that cannot exist exercises config reading,
// BunFileSystem, and error rendering with no network and no dependence on the developer's shell.
for (const name of Object.keys(process.env)) {
  if (name.startsWith("GOOGLE_")) delete process.env[name]
}
process.env["GOOGLE_SERVICE_ACCOUNT_KEY_FILE"] = "/nonexistent/amp-plugins-bundle-test/key.json"

const source = readFileSync(bundlePath, "utf8")
const bundle = (await import(bundlePath)) as {
  readonly default: (api: unknown) => void
  readonly description: string
}

describe("dist/google-workspace/index.js", () => {
  test("exports the description as the single literal Amp reads statically", () => {
    const literals = [...source.matchAll(/^export const description = "((?:[^"\\]|\\.)*)";$/gm)]
    expect(literals).toHaveLength(1)
    expect(JSON.parse(`"${literals[0]![1]}"`)).toBe(bundle.description)
    expect(bundle.description.length).toBeLessThanOrEqual(300)
    expect(source).not.toMatch(/^var description =/m)
  })

  test("inlines every dependency; only runtime builtins are imported (and never @ampcode/plugin)", () => {
    const imports = [...source.matchAll(/^import .* from "([^"]+)";?$/gm)].map((m) => m[1]!)
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
    const fields = new Map(
      stamp.trimEnd().split("\n").map((line): [string, string] => {
        const index = line.indexOf(": ")
        return [line.slice(0, index), line.slice(index + 2)]
      })
    )
    const field = (key: string): string => fields.get(key) ?? ""
    expect([...fields.keys()]).toEqual(["plugin", "release", "commit", "built", "source"])
    expect(field("plugin")).toBe("google-workspace")
    expect(field("release")).toMatch(/^(unreleased|v\d{4}\.\d{2}\.\d{2}(\.\d+)?)$/)
    expect(field("commit")).toMatch(/^([0-9a-f]{7}(-dirty)?|unknown)$/)
    expect(new Date(field("built")).toISOString()).toBe(field("built"))
    expect(field("source")).toBe(
      `https://github.com/scenesystems/amp-plugins/tree/${
        field("commit").replace(/-dirty$/, "")
      }/plugins/google-workspace`
    )
  })

  test("activates: nine tools, the command, the skill, one disposer", async () => {
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
    await amp.dispose()
  })

  test("runs a tool on Bun: config, file system, and error rendering work in the bundle", async () => {
    const amp = PluginApi.make()
    bundle.default(amp.api)
    const out = await amp.tool("gdrive_whoami").execute({}, amp.toolContext)
    expect(out).toBe(
      "Error: Google credential error: Cannot read service account key file /nonexistent/amp-plugins-bundle-test/key.json: NotFound: FileSystem.readFile (/nonexistent/amp-plugins-bundle-test/key.json)"
    )
    await amp.dispose()
  })
})
