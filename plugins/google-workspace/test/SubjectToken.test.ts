import * as BunChildProcessSpawner from "@effect/platform-bun/BunChildProcessSpawner"
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem"
import * as BunPath from "@effect/platform-bun/BunPath"
import { describe, it } from "@effect/vitest"
import * as Assert from "@effect/vitest/utils"
import { Assert as ExitAssert } from "@scenesystems/amp-plugin-testing"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as TestSchema from "effect/testing/TestSchema"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CredentialError, type SubjectTokenSource } from "../src/Credential.ts"
import { CompactJwt, layer as SubjectTokenLayer, ORB_ONLY_HINT, SubjectToken } from "../src/SubjectToken.ts"

const AUDIENCE =
  "https://iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/amp-orbs/providers/amp"
const JWT = "eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJhbXAifQ.c2ln"
const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Struct({ access_token: Schema.String })))

/** The real spawner and file system: these tests run `amp` for real, so the fake has to be a program. */
const live = SubjectTokenLayer.pipe(
  Layer.provide(BunChildProcessSpawner.layer),
  Layer.provide([BunFileSystem.layer, BunPath.layer])
)

const get = (source: SubjectTokenSource, audience = AUDIENCE) =>
  SubjectToken.use((s) => s.get(source, audience)).pipe(Effect.provide(live), Effect.exit)

/**
 * A temp directory that is the *only* entry on `PATH` for the duration of the test, holding an
 * executable `amp` that runs `body` (a `sh` fragment) and appends its argument vector to `argv`.
 */
const fakeAmp = Effect.fn("fakeAmp")(function*(body: string) {
  const dir = yield* Effect.acquireRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "gw-subject-token-"))),
    (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true }))
  )
  const argv = join(dir, "argv")
  const amp = join(dir, "amp")
  yield* Effect.promise(() => writeFile(amp, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argv}'\n${body}\n`))
  yield* Effect.promise(() => chmod(amp, 0o755))
  const previous = process.env["PATH"]
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      process.env["PATH"] = dir
    }),
    () =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env["PATH"]
        else process.env["PATH"] = previous
      })
  )
  return {
    dir,
    /** One argument per line, as the fake `amp` received them. */
    argv: Effect.promise(() => readFile(argv, "utf8")).pipe(Effect.map((text) => text.trimEnd().split("\n")))
  }
})

describe("SubjectToken: AmpOrb source", () => {
  it.live("runs `amp orb id-token --audience <audience>` and returns its stdout as a redacted token", () =>
    Effect.gen(function*() {
      const amp = yield* fakeAmp(`echo '${JWT}'`)
      const exit = yield* get({ _tag: "AmpOrb" })
      ExitAssert.assertSucceeds(exit, Redacted.make(JWT))
      Assert.deepStrictEqual(yield* amp.argv, ["orb", "id-token", "--audience", AUDIENCE])
    }))

  it.live("passes the audience it was given, not a fixed one", () =>
    Effect.gen(function*() {
      const amp = yield* fakeAmp(`echo '${JWT}'`)
      yield* get(
        { _tag: "AmpOrb" },
        "https://iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p/providers/q"
      )
      Assert.deepStrictEqual(yield* amp.argv, [
        "orb",
        "id-token",
        "--audience",
        "https://iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p/providers/q"
      ])
    }))

  it.live("reports a non-zero exit with the command's stderr and the orb-only hint", () =>
    Effect.gen(function*() {
      yield* fakeAmp(`echo 'error: not running inside an orb' >&2\nexit 1`)
      const exit = yield* get({ _tag: "AmpOrb" })
      ExitAssert.assertFails(
        exit,
        new CredentialError({
          message: "`amp orb id-token` exited with code 1: error: not running inside an orb",
          hint: ORB_ONLY_HINT
        })
      )
    }))

  it.live("says so when a failing command printed nothing", () =>
    Effect.gen(function*() {
      yield* fakeAmp(`exit 2`)
      const exit = yield* get({ _tag: "AmpOrb" })
      ExitAssert.assertFails(
        exit,
        new CredentialError({ message: "`amp orb id-token` exited with code 2: no error output", hint: ORB_ONLY_HINT })
      )
    }))

  it.live("rejects a zero exit whose stdout is not a JWT, without forwarding that output anywhere", () =>
    Effect.gen(function*() {
      yield* fakeAmp(`echo 'Update available: run amp update'`)
      const exit = yield* get({ _tag: "AmpOrb" })
      ExitAssert.assertFails(
        exit,
        new CredentialError({
          message: "`amp orb id-token` did not produce a JWT (expected header.payload.signature)."
        })
      )
    }))

  it.live("rejects an empty stdout the same way", () =>
    Effect.gen(function*() {
      yield* fakeAmp(`exit 0`)
      const exit = yield* get({ _tag: "AmpOrb" })
      ExitAssert.assertFails(
        exit,
        new CredentialError({
          message: "`amp orb id-token` did not produce a JWT (expected header.payload.signature)."
        })
      )
    }))

  it.live("reports a missing `amp` binary as a spawn failure with the orb-only hint", () =>
    Effect.gen(function*() {
      const amp = yield* fakeAmp("")
      yield* Effect.promise(() => rm(join(amp.dir, "amp")))
      const exit = yield* get({ _tag: "AmpOrb" })
      ExitAssert.assertFails(
        exit,
        new CredentialError({
          message:
            `Could not run \`amp orb id-token\`: NotFound: ChildProcess.spawn (amp orb id-token --audience ${AUDIENCE})`,
          hint: ORB_ONLY_HINT
        })
      )
    }))
})

describe("SubjectToken: File source", () => {
  const tempDir = Effect.acquireRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "gw-token-file-"))),
    (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true }))
  )

  it.live("reads the token from the file, tolerating a trailing newline", () =>
    Effect.gen(function*() {
      const path = join(yield* tempDir, "token")
      yield* Effect.promise(() => writeFile(path, `${JWT}\n`))
      ExitAssert.assertSucceeds(yield* get({ _tag: "File", path }), Redacted.make(JWT))
    }))

  it.live("names the file when it cannot be read", () =>
    Effect.gen(function*() {
      const path = join(yield* tempDir, "missing")
      const exit = yield* get({ _tag: "File", path })
      const error = ExitAssert.failureOf(exit)
      Assert.assertInstanceOf(error, CredentialError)
      Assert.strictEqual(error.hint, undefined)
      Assert.strictEqual(
        error.message,
        `Cannot read workload identity token file ${path}: NotFound: FileSystem.readFile (${path})`
      )
    }))

  it.live("rejects a file that does not hold a JWT", () =>
    Effect.gen(function*() {
      const path = join(yield* tempDir, "token")
      yield* Effect.promise(() => writeFile(path, toJson({ access_token: "ya29.not-a-jwt" })))
      ExitAssert.assertFails(
        yield* get({ _tag: "File", path }),
        new CredentialError({
          message: `Token file ${path} did not produce a JWT (expected header.payload.signature).`
        })
      )
    }))
})

describe("SubjectToken.CompactJwt schema", () => {
  const asserts = new TestSchema.Asserts(CompactJwt)

  it.effect("accepts three non-empty base64url segments", () =>
    Effect.gen(function*() {
      yield* Effect.promise(() => asserts.decoding().succeed(JWT, JWT))
      yield* Effect.promise(() => asserts.decoding().succeed("a.b.c", "a.b.c"))
      yield* Effect.promise(() => asserts.decoding().succeed("A-_9.B-_8.C-_7", "A-_9.B-_8.C-_7"))
    }))

  it.effect("rejects padding, missing segments, and characters outside base64url", () =>
    Effect.gen(function*() {
      const expected = "Expected a string matching the RegExp ^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$"
      yield* Effect.promise(() => asserts.decoding().fail("a.b", expected))
      yield* Effect.promise(() => asserts.decoding().fail("a.b.c.d", expected))
      yield* Effect.promise(() => asserts.decoding().fail("a.b.", expected))
      yield* Effect.promise(() => asserts.decoding().fail("a=.b.c", expected))
      yield* Effect.promise(() => asserts.decoding().fail("a+b.c.d", expected))
      yield* Effect.promise(() => asserts.decoding().fail("", expected))
    }))
})
