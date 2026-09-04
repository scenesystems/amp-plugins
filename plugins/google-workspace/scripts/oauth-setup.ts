#!/usr/bin/env bun
/**
 * One-time helper to obtain a Google OAuth refresh token for the google-workspace Amp plugin.
 *
 * Run on a machine with a browser, from a clone of github.com/scenesystems/amp-plugins:
 *
 *   GOOGLE_OAUTH_CLIENT_ID=... GOOGLE_OAUTH_CLIENT_SECRET=... \
 *     bun run plugins/google-workspace/scripts/oauth-setup.ts [--read-only]
 *
 * Requires an OAuth client of type "Desktop app" (loopback redirect). Prints the refresh token and
 * the `amp secrets set --user ...` command that stores it as a personal secret.
 *
 * This is a developer-machine script, not plugin code, and is not part of the built plugin bundle.
 * It runs a loopback HTTP server on an ephemeral port until Google redirects back with the code,
 * then exchanges the code for tokens.
 */
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer"
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as Arr from "effect/Array"
import * as Cause from "effect/Cause"
import * as Config from "effect/Config"
import * as Console from "effect/Console"
import * as Crypto from "effect/Crypto"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as Layer from "effect/Layer"
import * as Match from "effect/Match"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpServer from "effect/unstable/http/HttpServer"
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import * as Url from "effect/unstable/http/Url"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"
import { SCOPE_FULL, SCOPE_READ_ONLY } from "../src/Credential.ts"

class SetupError extends Schema.TaggedError<SetupError>()("SetupError", {
  message: Schema.String,
  hint: Schema.optionalKey(Schema.String)
}) {}

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
const TOKEN_URL = "https://oauth2.googleapis.com/token"

const TokenExchange = Schema.Struct({
  refresh_token: Schema.optionalKey(Schema.Redacted(Schema.String)),
  error: Schema.optionalKey(Schema.String),
  error_description: Schema.optionalKey(Schema.String)
})
const decodeTokenExchange = Schema.decodeEffect(Schema.fromJsonString(TokenExchange))

/** What Google sends back to the loopback redirect. */
const Callback = Schema.Struct({
  code: Schema.optionalKey(Schema.String),
  state: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String)
})
const decodeCallback = Schema.decodeUnknownEffect(Callback)

/** A required, non-blank environment variable. */
const required = (name: string): Effect.Effect<string, SetupError | Config.ConfigError> =>
  Config.string(name).pipe(
    Config.map((value) => value.trim()),
    Effect.filterOrFail(
      (value) => value !== "",
      () => new SetupError({ message: `${name} is set but blank.` })
    )
  )

const plain = (status: number, body: string) => HttpServerResponse.text(body).pipe(HttpServerResponse.setStatus(status))

/**
 * Handles the single `/callback` request: completes `outcome` with the authorization code, or with a
 * `SetupError` describing why Google's redirect cannot be used. Every other path is a 404.
 */
const callbackHandler = (redirectUri: string, expectedState: string, outcome: Deferred.Deferred<string, SetupError>) =>
  Effect.gen(function*() {
    const request = yield* HttpServerRequest.HttpServerRequest
    const parsed = Url.fromString(request.url, redirectUri)
    if (Result.isFailure(parsed) || parsed.success.pathname !== "/callback") {
      return plain(404, "Not found")
    }
    const url = parsed.success
    const params = yield* decodeCallback(HttpServerRequest.searchParamsFromURL(url))
    const complete = (error: SetupError, status: number, body: string) =>
      Deferred.fail(outcome, error).pipe(Effect.as(plain(status, body)))
    return yield* Match.value(params).pipe(
      Match.when({ error: Match.string }, ({ error }) =>
        complete(
          new SetupError({ message: `Authorization failed: ${error}` }),
          400,
          `Authorization failed: ${error}`
        )),
      Match.when(
        { code: Match.string, state: (state) => state === expectedState },
        ({ code }) =>
          Deferred.succeed(outcome, code).pipe(
            Effect.as(
              HttpServerResponse.html(
                "<h2>Amp google-workspace: authorized.</h2><p>You can close this tab and return to the terminal.</p>"
              )
            )
          )
      ),
      Match.when(
        { code: Match.string },
        () => complete(new SetupError({ message: "OAuth state mismatch" }), 400, "State mismatch; try again.")
      ),
      Match.orElse(() => complete(new SetupError({ message: "Missing authorization code" }), 400, "Missing code."))
    )
  })

/** Best effort: opens the URL in the default browser; the user can also copy it from the terminal. */
const openInBrowser = (url: string) =>
  Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const [program, args] = Match.value(process.platform).pipe(
      Match.when("darwin", (): readonly [string, ReadonlyArray<string>] => ["open", [url]]),
      Match.when("win32", (): readonly [string, ReadonlyArray<string>] => ["cmd", ["/c", "start", "", url]]),
      Match.orElse((): readonly [string, ReadonlyArray<string>] => ["xdg-open", [url]])
    )
    yield* spawner.exitCode(ChildProcess.make(program, args, { detached: true }))
  }).pipe(Effect.ignore)

const loopbackPort = (address: HttpServer.Address): Effect.Effect<number, SetupError> =>
  Match.valueTags(address, {
    TcpAddress: (tcp) => Effect.succeed(tcp.port),
    UnixAddress: () => Effect.fail(new SetupError({ message: "Loopback server did not bind a TCP port" }))
  })

const main = Effect.gen(function*() {
  const clientId = yield* required("GOOGLE_OAUTH_CLIENT_ID")
  const clientSecret = yield* Config.redacted("GOOGLE_OAUTH_CLIENT_SECRET")
  const readOnly = Arr.contains(Bun.argv, "--read-only")
  const scope = readOnly ? SCOPE_READ_ONLY : SCOPE_FULL

  const crypto = yield* Crypto.Crypto
  const state = Encoding.encodeHex(yield* crypto.randomBytes(16))

  const server = yield* HttpServer.HttpServer
  const port = yield* loopbackPort(server.address)
  const redirectUri = `http://127.0.0.1:${port}/callback`
  const outcome = yield* Deferred.make<string, SetupError>()
  yield* HttpServer.serveEffect()(callbackHandler(redirectUri, state, outcome))

  const authUrl = Url.setUrlParams(new URL(AUTH_URL), {
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope,
    access_type: "offline",
    prompt: "consent",
    state
  }).toString()

  yield* Console.log("\nOpen this URL in your browser to authorize the plugin:\n")
  yield* Console.log(authUrl)
  yield* Console.log(`\nWaiting for Google to redirect back to ${redirectUri} ...\n`)
  yield* openInBrowser(authUrl)

  const code = yield* Deferred.await(outcome)

  const client = yield* HttpClient.HttpClient
  const response = yield* client.execute(
    HttpClientRequest.post(TOKEN_URL).pipe(
      HttpClientRequest.bodyUrlParams({
        code,
        client_id: clientId,
        client_secret: Redacted.value(clientSecret),
        redirect_uri: redirectUri,
        grant_type: "authorization_code"
      })
    )
  )
  const token = yield* decodeTokenExchange(yield* response.text)
  const refreshToken = yield* Option.match(Option.fromNullishOr(token.refresh_token), {
    onSome: (refreshToken) => Effect.succeed(refreshToken),
    onNone: () =>
      new SetupError({
        message: `Token exchange failed (HTTP ${response.status}): ${token.error ?? "no refresh_token returned"}${
          token.error_description === undefined ? "" : ` — ${token.error_description}`
        }`,
        hint: "If no refresh_token was returned, revoke the app at https://myaccount.google.com/permissions and retry."
      })
  })

  yield* Console.log("Success. Store the refresh token as a PERSONAL Amp secret:\n")
  yield* Console.log(
    `  printf %s '${
      Redacted.value(refreshToken)
    }' | amp secrets set --user GOOGLE_OAUTH_REFRESH_TOKEN --secret --data-file -\n`
  )
  yield* Console.log(
    "Make sure GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET are also set (workspace secrets are fine)."
  )
  if (readOnly) {
    yield* Console.log("This token was issued with the read-only scope; also set GOOGLE_WORKSPACE_READ_ONLY=1.")
  }
}).pipe(Effect.scoped)

const describe = (error: SetupError): string =>
  error.hint === undefined ? error.message : `${error.message}\n${error.hint}`

/** Setup and configuration errors are shown as a message and hint; anything else is unexpected and shown in full. */
const report = <E>(cause: Cause.Cause<E>): string =>
  Cause.findErrorOption(cause).pipe(
    Option.map((error) =>
      Schema.is(SetupError)(error)
        ? describe(error)
        : error instanceof Config.ConfigError
        ? describe(
          new SetupError({
            message: `Missing or invalid configuration: ${error.message}`,
            hint: "Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET in the environment first."
          })
        )
        : Cause.pretty(cause)
    ),
    Option.getOrElse(() => Cause.pretty(cause))
  )

const layer = Layer.mergeAll(
  BunHttpServer.layer({ port: 0, hostname: "127.0.0.1" }),
  FetchHttpClient.layer
)

BunRuntime.runMain(
  // oxlint-disable-next-line effecttsgo/strict-effect-provide -- this is the script's entry point
  Effect.provide(main, layer).pipe(Effect.tapCause((cause) => Console.error(report(cause)))),
  { disableErrorReporting: true }
)
