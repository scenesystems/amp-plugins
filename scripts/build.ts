/**
 * Bundles every plugin under `plugins/*` into `dist/<name>/`:
 *
 *   dist/<name>/index.js   single-file bundle (Effect and shared packages inlined; runs on Bun with no install)
 *   dist/<name>/BUILD      provenance: plugin, release tag, source commit, build time, source URL
 *   dist/<name>/skills/    copied verbatim when the plugin ships skills
 *   dist/<name>/README.md  copied when present
 *
 * Each `dist/<name>` directory is a complete directory plugin: `amp plugins add ./dist/<name>`,
 * or copy it into an Amp plugin repository.
 *
 * Plugins carry no version numbers of their own. A release is a snapshot of this repository, so the
 * identity of a build is the release tag plus the commit, both recorded in BUILD. The release workflow
 * sets RELEASE_TAG; local builds are stamped `unreleased`.
 *
 * Usage: bun run scripts/build.ts [plugin-name ...]
 */
import { cp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dir, "..")
const pluginsDir = join(root, "plugins")
const distDir = join(root, "dist")
const repository = "https://github.com/scenesystems/amp-plugins"

const exists = (path: string) => stat(path).then(() => true, () => false)

const git = (...args: Array<string>): string | undefined => {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "ignore" })
  return result.exitCode === 0 ? result.stdout.toString().trim() : undefined
}

/** `<short sha>`, with `-dirty` when tracked files differ from HEAD; `unknown` outside a Git checkout. */
const sourceCommit = (): string => {
  const sha = git("rev-parse", "--short=7", "HEAD") ?? process.env["GITHUB_SHA"]?.slice(0, 7)
  if (sha === undefined) return "unknown"
  const dirty = git("status", "--porcelain", "--untracked-files=no")
  return dirty === undefined || dirty === "" ? sha : `${sha}-dirty`
}

const commit = sourceCommit()
const release = process.env["RELEASE_TAG"]?.trim() || "unreleased"
const builtAt = new Date().toISOString()

const buildStamp = (name: string): string =>
  [
    `plugin: ${name}`,
    `release: ${release}`,
    `commit: ${commit}`,
    `built: ${builtAt}`,
    `source: ${repository}/tree/${commit.replace(/-dirty$/, "")}/plugins/${name}`,
    ""
  ].join("\n")

const listPlugins = async (): Promise<Array<string>> => {
  const entries = await readdir(pluginsDir, { withFileTypes: true })
  const names = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  const results = await Promise.all(names.map((name) => exists(join(pluginsDir, name, "src/index.ts"))))
  return names.filter((_, index) => results[index])
}

/**
 * Amp reads the `description` export statically and requires a literal `export const description = "..."`.
 * Bun emits `var description = "..."` plus a trailing `export { description, ... }`, so rewrite the bundle
 * back into the literal form Amp expects.
 */
const restoreStaticDescription = async (bundlePath: string): Promise<void> => {
  const file = Bun.file(bundlePath)
  const source = await file.text()
  const declaration = /^var description = ("(?:[^"\\\n]|\\.)*");$/m
  const exportEntry = /^(export \{\n(?:  .*\n)*?)  description,\n/m
  if (!declaration.test(source) || !exportEntry.test(source)) {
    throw new Error(`${bundlePath}: could not find the \`description\` export to restore; check the bundle shape`)
  }
  const rewritten = source
    .replace(declaration, "export const description = $1;")
    .replace(exportEntry, "$1")
  await Bun.write(file, rewritten)
}

const buildPlugin = async (name: string): Promise<void> => {
  const pluginDir = join(pluginsDir, name)
  const outDir = join(distDir, name)
  await rm(outDir, { recursive: true, force: true })
  await mkdir(outDir, { recursive: true })

  const result = await Bun.build({
    entrypoints: [join(pluginDir, "src/index.ts")],
    outdir: outDir,
    target: "bun",
    format: "esm",
    naming: "index.js",
    // No source map: it is ~8x the bundle and would be cloned by every plugin-repository reader.
    // The bundle is unminified, so stack traces stay readable without one.
    sourcemap: "none",
    minify: false,
    // Types-only package; never needed at runtime.
    external: ["@ampcode/plugin"]
  })
  if (!result.success) {
    for (const log of result.logs) console.error(log)
    throw new Error(`bun build failed for ${name}`)
  }
  await restoreStaticDescription(join(outDir, "index.js"))

  for (const extra of ["skills", "README.md"]) {
    const source = join(pluginDir, extra)
    if (await exists(source)) await cp(source, join(outDir, extra), { recursive: true })
  }
  await writeFile(join(outDir, "BUILD"), buildStamp(name))

  const size = (await stat(join(outDir, "index.js"))).size
  console.log(`built dist/${name}/index.js (${(size / 1024).toFixed(0)} KiB) ${release} ${commit}`)
}

const requested = Bun.argv.slice(2)
const available = await listPlugins()
const unknown = requested.filter((name) => !available.includes(name))
if (unknown.length > 0) {
  throw new Error(`unknown plugin(s): ${unknown.join(", ")}. Available: ${available.join(", ")}`)
}
for (const name of requested.length > 0 ? requested : available) {
  await buildPlugin(name)
}
