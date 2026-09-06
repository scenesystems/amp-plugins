import * as BunChildProcessSpawner from "@effect/platform-bun/BunChildProcessSpawner"
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem"
import * as BunPath from "@effect/platform-bun/BunPath"
import { describe, it } from "@effect/vitest"
import * as Assert from "@effect/vitest/utils"
import { Assert as ExitAssert } from "@scenesystems/amp-plugin-testing"
import * as Arr from "effect/Array"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as FastCheck from "effect/testing/FastCheck"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { callbackCode, clientId, decodeTokenExchange, savePersonal, SetupError } from "../scripts/OAuthSetup.ts"

const redirect = "http://127.0.0.1:43210/callback"
const state = "expected-state"

describe("OAuth setup", () => {
  it.effect("decodes Google's plain refresh token into a redacted value", () =>
    Effect.gen(function*() {
      const response = yield* decodeTokenExchange("{\"refresh_token\":\"private-token\",\"access_token\":\"unused\"}")
      Assert.assertEquals(response, { refresh_token: Redacted.make("private-token") })
      ExitAssert.assertRedacted(response, ["private-token"])
    }))

  it("accepts generated Google client IDs", () => {
    FastCheck.assert(
      FastCheck.property(
        FastCheck.stringMatching(/^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/),
        (value) => Assert.strictEqual(Schema.decodeSync(clientId)(value), value)
      )
    )
  })
  it("rejects URL-shaped and wrapped client IDs", () => {
    Assert.deepStrictEqual(
      Arr.map([
        "123-abc.apps.googleusercontent.com",
        "http://123-abc.apps.googleusercontent.com/",
        "123-ab\nc.apps.googleusercontent.com"
      ], Schema.is(clientId)),
      [true, false, false]
    )
  })

  it.effect("decodes the callback code without exposing it", () =>
    Effect.gen(function*() {
      const result = yield* callbackCode(
        Redacted.make(`${redirect}?state=${state}&code=private%2Bcode`),
        redirect,
        state
      )
      Assert.strictEqual(Redacted.value(result), "private+code")
    }))

  it.effect("rejects invalid, stale, denied, and ambiguous callbacks with safe errors", () =>
    Effect.gen(function*() {
      const cases: ReadonlyArray<readonly [string, string]> = [
        ["not a URL", "Paste the complete callback URL from your browser's address bar."],
        [
          `http://127.0.0.1:1/callback?state=${state}&code=secret`,
          "Callback URL does not match this setup session. Use the latest authorization link."
        ],
        [`${redirect}?state=stale&code=secret`, "OAuth state mismatch. Use the callback from this setup session."],
        [
          `${redirect}?state=${state}&state=${state}&code=secret`,
          "OAuth state mismatch. Use the callback from this setup session."
        ],
        [`${redirect}?state=${state}&error=secret`, "Google authorization was denied. Restart setup to try again."],
        [`${redirect}?state=${state}`, "Callback URL must contain exactly one authorization code."],
        [
          `${redirect}?state=${state}&code=secret&code=other`,
          "Callback URL must contain exactly one authorization code."
        ]
      ]
      yield* Effect.forEach(cases, ([url, message]) =>
        Effect.gen(function*() {
          ExitAssert.assertFails(
            yield* Effect.exit(callbackCode(Redacted.make(url), redirect, state)),
            new SetupError({ message })
          )
        }))
    }))

  it.live("saves only personal secrets via stdin and reports nonzero saves without leaking output", () =>
    Effect.gen(function*() {
      const dir = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(join(tmpdir(), "oauth-setup-test-"))),
        (path) => Effect.promise(() => rm(path, { recursive: true, force: true }))
      )
      const amp = join(dir, "amp")
      yield* Effect.promise(() =>
        writeFile(
          amp,
          `#!/bin/sh
printf '%s\\n' "$@" > '${dir}/args'
/bin/cat > '${dir}/stdin'
echo sensitive-output
echo sensitive-error >&2
[ "$4" = GOOGLE_OAUTH_REFRESH_TOKEN ]
`
        )
      )
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
      const live = BunChildProcessSpawner.layer.pipe(Layer.provide([BunFileSystem.layer, BunPath.layer]))
      yield* savePersonal("GOOGLE_OAUTH_REFRESH_TOKEN", Redacted.make("private-token"), "--secret").pipe(
        Effect.provide(live)
      )
      Assert.strictEqual(
        yield* Effect.promise(() => readFile(join(dir, "args"), "utf8")),
        "secrets\nset\n--user\nGOOGLE_OAUTH_REFRESH_TOKEN\n--secret\n--data-file\n-\n"
      )
      Assert.strictEqual(yield* Effect.promise(() => readFile(join(dir, "stdin"), "utf8")), "private-token")
      ExitAssert.assertFails(
        yield* savePersonal("FAIL", Redacted.make("private-token"), "--secret").pipe(
          Effect.provide(live),
          Effect.exit
        ),
        new SetupError({ message: "Could not save FAIL. Check Amp CLI login and retry setup." })
      )
    }))
})
