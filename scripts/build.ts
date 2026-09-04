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
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import * as Arr from "effect/Array"
import * as Config from "effect/Config"
import * as Console from "effect/Console"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"

class BuildError extends Schema.TaggedError<BuildError>()("BuildError", {
  message: Schema.String
}) {}

const repository = "https://github.com/scenesystems/amp-plugins"

/** An optional environment variable, blank treated as unset. */
const optionalEnv = (name: string): Config.Config<Option.Option<string>> =>
  Config.string(name).pipe(
    Config.map((value) => value.trim()),
    Config.option,
    Config.map(Option.filter((value) => value !== ""))
  )

const collect = (stream: Stream.Stream<Uint8Array, unknown>): Effect.Effect<string> =>
  stream.pipe(Stream.decodeText(), Stream.mkString, Effect.orElseSucceed(() => ""))

/** Trimmed stdout of a git command that exited 0; `None` for any failure, including "not a Git checkout". */
const git = Effect.fn("git")(
  function*(cwd: string, ...args: ReadonlyArray<string>) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const handle = yield* spawner.spawn(ChildProcess.make("git", args, { cwd }))
    const stdout = yield* collect(handle.stdout)
    const exitCode = yield* handle.exitCode
    return exitCode === 0 ? Option.some(stdout.trim()) : Option.none()
  },
  Effect.scoped,
  Effect.orElseSucceed(() => Option.none<string>())
)

/** `<short sha>`, with `-dirty` when tracked files differ from HEAD; `unknown` outside a Git checkout. */
const sourceCommit = Effect.fn("sourceCommit")(function*(root: string) {
  const fromGit = yield* git(root, "rev-parse", "--short=7", "HEAD")
  const fromCi = yield* optionalEnv("GITHUB_SHA").pipe(Effect.map(Option.map((sha) => sha.slice(0, 7))))
  const sha = Option.orElse(fromGit, () => fromCi)
  return yield* Option.match(sha, {
    onNone: () => Effect.succeed("unknown"),
    onSome: (sha) =>
      git(root, "status", "--porcelain", "--untracked-files=no").pipe(
        Effect.map(Option.match({ onNone: () => sha, onSome: (status) => status === "" ? sha : `${sha}-dirty` }))
      )
  })
})

interface Stamp {
  readonly release: string
  readonly commit: string
  readonly builtAt: string
}

const buildStamp = (name: string, stamp: Stamp): string =>
  [
    `plugin: ${name}`,
    `release: ${stamp.release}`,
    `commit: ${stamp.commit}`,
    `built: ${stamp.builtAt}`,
    `source: ${repository}/tree/${stamp.commit.replace(/-dirty$/, "")}/plugins/${name}`,
    ""
  ].join("\n")

/**
 * Amp reads the `description` export statically and requires a literal `export const description = "..."`.
 * Bun emits `var description = "..."` plus a trailing `export { description, ... }`, so rewrite the bundle
 * back into the literal form Amp expects.
 */
const restoreStaticDescription = Effect.fn("restoreStaticDescription")(function*(bundlePath: string) {
  const fs = yield* FileSystem.FileSystem
  const declaration = /^var description = ("(?:[^"\\\n]|\\.)*");$/m
  const exportEntry = /^(export \{\n(?:  .*\n)*?)  description,\n/m
  const source = yield* fs.readFileString(bundlePath).pipe(
    Effect.filterOrFail(
      (text) => declaration.test(text) && exportEntry.test(text),
      () =>
        new BuildError({
          message: `${bundlePath}: could not find the \`description\` export to restore; check the bundle shape`
        })
    )
  )
  const rewritten = source
    .replace(declaration, "export const description = $1;")
    .replace(exportEntry, "$1")
  yield* fs.writeFileString(bundlePath, rewritten)
})

const bundle = (entrypoint: string, outDir: string, name: string) =>
  Effect.promise(() =>
    Bun.build({
      entrypoints: [entrypoint],
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
  ).pipe(
    Effect.filterOrElse(
      (result) => result.success,
      (result) =>
        Effect.forEach(result.logs, (log) => Console.error(log), { discard: true }).pipe(
          Effect.andThen(new BuildError({ message: `bun build failed for ${name}` }))
        )
    )
  )

const buildPlugin = Effect.fn("buildPlugin")(
  function*(pluginsDir: string, distDir: string, stamp: Stamp, name: string) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const pluginDir = path.join(pluginsDir, name)
    const outDir = path.join(distDir, name)
    yield* fs.remove(outDir, { recursive: true, force: true })
    yield* fs.makeDirectory(outDir, { recursive: true })

    yield* bundle(path.join(pluginDir, "src/index.ts"), outDir, name)
    yield* restoreStaticDescription(path.join(outDir, "index.js"))

    yield* Effect.forEach(["skills", "README.md"], (extra) => {
      const source = path.join(pluginDir, extra)
      return Effect.when(fs.copy(source, path.join(outDir, extra)), fs.exists(source))
    }, { discard: true })
    yield* fs.writeFileString(path.join(outDir, "BUILD"), buildStamp(name, stamp))

    const info = yield* fs.stat(path.join(outDir, "index.js"))
    yield* Console.log(
      `built dist/${name}/index.js (${(Number(info.size) / 1024).toFixed(0)} KiB) ${stamp.release} ${stamp.commit}`
    )
  }
)

const main = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = path.resolve(import.meta.dir, "..")
  const pluginsDir = path.join(root, "plugins")
  const distDir = path.join(root, "dist")

  const entries = yield* fs.readDirectory(pluginsDir)
  const available = yield* Effect.filter(entries, (name) => fs.exists(path.join(pluginsDir, name, "src/index.ts")))
  const requested = Arr.drop(Bun.argv, 2)
  yield* Effect.succeed(Arr.difference(requested, available)).pipe(
    Effect.filterOrFail(
      Arr.isReadonlyArrayEmpty,
      (unknown) =>
        new BuildError({
          message: `unknown plugin(s): ${unknown.join(", ")}. Available: ${available.join(", ")}`
        })
    )
  )

  const stamp: Stamp = {
    release: Option.getOrElse(yield* optionalEnv("RELEASE_TAG"), () => "unreleased"),
    commit: yield* sourceCommit(root),
    builtAt: DateTime.formatIso(yield* DateTime.now)
  }
  const targets = Arr.isReadonlyArrayNonEmpty(requested) ? requested : available
  yield* Effect.forEach(targets, (name) => buildPlugin(pluginsDir, distDir, stamp, name), { discard: true })
})

// oxlint-disable-next-line effecttsgo/strict-effect-provide -- this is the script's entry point
BunRuntime.runMain(Effect.provide(main, BunServices.layer))
