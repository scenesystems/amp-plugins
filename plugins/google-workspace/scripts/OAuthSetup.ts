import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as Url from "effect/unstable/http/Url"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"

export class SetupError extends Schema.TaggedError<SetupError>()("SetupError", {
  message: Schema.String,
  hint: Schema.optionalKey(Schema.String)
}) {}

export const clientId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/))
)

export const decodeTokenExchange = Schema.decodeEffect(Schema.fromJsonString(Schema.Struct({
  refresh_token: Schema.optionalKey(Schema.RedactedFromValue(Schema.String))
})))

/** Never include the pasted URL or a schema error containing its authorization code in diagnostics. */
export const callbackCode = Effect.fn("callbackCode")(function*(
  input: Redacted.Redacted,
  redirectUri: string,
  expectedState: string
) {
  const parsed = Url.fromString(Redacted.value(input).trim())
  if (Result.isFailure(parsed)) {
    return yield* new SetupError({ message: "Paste the complete callback URL from your browser's address bar." })
  }
  const url = parsed.success
  const expected = new URL(redirectUri)
  if (
    url.origin !== expected.origin || url.pathname !== expected.pathname || url.hash !== "" ||
    url.username !== "" || url.password !== ""
  ) {
    return yield* new SetupError({
      message: "Callback URL does not match this setup session. Use the latest authorization link."
    })
  }
  if (url.searchParams.getAll("state").length !== 1 || url.searchParams.get("state") !== expectedState) {
    return yield* new SetupError({ message: "OAuth state mismatch. Use the callback from this setup session." })
  }
  if (url.searchParams.has("error")) {
    return yield* new SetupError({ message: "Google authorization was denied. Restart setup to try again." })
  }
  const code = url.searchParams.get("code")
  if (code === null || code.trim() === "" || url.searchParams.getAll("code").length !== 1) {
    return yield* new SetupError({ message: "Callback URL must contain exactly one authorization code." })
  }
  return Redacted.make(code)
})

/** Secrets travel over stdin, never arguments or captured child output. */
export const savePersonal = Effect.fn("savePersonal")(function*(
  name: string,
  value: Redacted.Redacted,
  kind: "--env" | "--secret"
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const status = yield* spawner.exitCode(ChildProcess.make("amp", [
    "secrets",
    "set",
    "--user",
    name,
    kind,
    "--data-file",
    "-"
  ], {
    stdin: Stream.succeed(new TextEncoder().encode(Redacted.value(value))),
    stdout: "ignore",
    stderr: "ignore"
  })).pipe(
    Effect.mapError(() => new SetupError({ message: `Could not save ${name}. Check Amp CLI login and retry setup.` }))
  )
  if (status !== 0) {
    return yield* new SetupError({ message: `Could not save ${name}. Check Amp CLI login and retry setup.` })
  }
  return undefined
})
