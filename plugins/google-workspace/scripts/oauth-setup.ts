#!/usr/bin/env bun
/**
 * One-time helper to obtain a Google OAuth refresh token for the google-workspace Amp plugin.
 *
 * Run locally, or use --manual in an orb with a browser on another device:
 *
 *   GOOGLE_OAUTH_CLIENT_ID=... GOOGLE_OAUTH_CLIENT_SECRET=... \
 *     bun run plugins/google-workspace/scripts/oauth-setup.ts [--read-only] [--manual]
 *
 * Requires an OAuth client of type "Desktop app" (loopback redirect). Manual mode accepts a hidden
 * callback URL and saves personal Amp configuration without printing tokens. Local mode prints
 * the refresh token and the command to store it.
 *
 * This setup script runs in a terminal and is not part of the built plugin bundle. It uses a
 * loopback redirect on an ephemeral port. Local mode receives the callback over HTTP; manual mode
 * accepts the callback URL through a hidden terminal prompt. Both exchange the code for tokens.
 */
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer"
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunTerminal from "@effect/platform-bun/BunTerminal"
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
import * as Prompt from "effect/unstable/cli/Prompt"
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
import { callbackCode, clientId as ClientId, decodeTokenExchange, savePersonal, SetupError } from "./OAuthSetup.ts"

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
const TOKEN_URL = "https://oauth2.googleapis.com/token"

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
  const clientId = yield* required("GOOGLE_OAUTH_CLIENT_ID").pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(ClientId)),
    Effect.mapError(() =>
      new SetupError({
        message:
          "GOOGLE_OAUTH_CLIENT_ID must be the bare Google client ID ending in .apps.googleusercontent.com (no URL prefix, slash, or embedded whitespace)."
      })
    )
  )
  const clientSecret = yield* Config.redacted("GOOGLE_OAUTH_CLIENT_SECRET")
  const readOnly = Arr.contains(Bun.argv, "--read-only")
  const manual = Arr.contains(Bun.argv, "--manual")
  const scope = readOnly ? SCOPE_READ_ONLY : SCOPE_FULL

  const crypto = yield* Crypto.Crypto
  const state = Encoding.encodeHex(yield* crypto.randomBytes(16))
  const verifier = Encoding.encodeBase64Url(yield* crypto.randomBytes(32))
  const challenge = Encoding.encodeBase64Url(yield* crypto.digest("SHA-256", new TextEncoder().encode(verifier)))

  const server = yield* HttpServer.HttpServer
  const port = yield* loopbackPort(server.address)
  const redirectUri = `http://127.0.0.1:${port}/callback`
  const outcome = yield* Deferred.make<string, SetupError>()
  if (!manual) {
    yield* HttpServer.serveEffect()(callbackHandler(redirectUri, state, outcome))
  }

  const authUrl = Url.setUrlParams(new URL(AUTH_URL), {
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope,
    access_type: "offline",
    prompt: "consent",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256"
  }).toString()

  yield* Console.log("\nOpen this URL in your browser to authorize the plugin:\n")
  yield* Console.log(authUrl)
  const code = manual
    ? yield* Effect.gen(function*() {
      yield* Console.log(
        "\nUse your normal browser on your own device. After consent, a loopback connection error is expected."
      )
      yield* Console.log(
        "Copy the complete final URL from the address bar into the hidden prompt below. Never paste it into chat."
      )
      const callback = yield* Prompt.run(Prompt.hidden({ message: "Callback URL (hidden)" }))
      return Redacted.value(yield* callbackCode(callback, redirectUri, state))
    })
    : yield* Effect.gen(function*() {
      yield* Console.log(`\nWaiting for Google to redirect back to ${redirectUri} ...\n`)
      yield* openInBrowser(authUrl)
      return yield* Deferred.await(outcome)
    })

  const client = yield* HttpClient.HttpClient
  const response = yield* client.execute(
    HttpClientRequest.post(TOKEN_URL).pipe(
      HttpClientRequest.bodyUrlParams({
        code,
        client_id: clientId,
        client_secret: Redacted.value(clientSecret),
        redirect_uri: redirectUri,
        code_verifier: verifier,
        grant_type: "authorization_code"
      })
    )
  ).pipe(
    Effect.mapError(() =>
      new SetupError({ message: "Could not reach Google's token endpoint. Restart setup to retry." })
    )
  )
  const token = yield* response.text.pipe(
    Effect.flatMap(decodeTokenExchange),
    Effect.mapError(() => new SetupError({ message: "Google returned an invalid token response. Restart setup." }))
  )
  const refreshToken = yield* Option.match(Option.fromNullishOr(token.refresh_token), {
    onSome: (refreshToken) => Effect.succeed(refreshToken),
    onNone: () =>
      new SetupError({
        message: `Token exchange failed (HTTP ${response.status}).`,
        hint: "If no refresh_token was returned, revoke the app at https://myaccount.google.com/permissions and retry."
      })
  })

  if (manual) {
    yield* savePersonal("GOOGLE_OAUTH_CLIENT_ID", Redacted.make(clientId), "--env")
    yield* savePersonal("GOOGLE_OAUTH_CLIENT_SECRET", clientSecret, "--secret")
    yield* savePersonal("GOOGLE_WORKSPACE_READ_ONLY", Redacted.make(readOnly ? "1" : "0"), "--env")
    // Save the token last: until it exists, workspace WIF remains selected.
    yield* savePersonal("GOOGLE_OAUTH_REFRESH_TOKEN", refreshToken, "--secret")
    yield* Console.log(
      "Saved personal OAuth configuration to Amp. Workspace service-account settings were not changed."
    )
    yield* Console.log("Run amp orb restart-processes, then verify your Google email and scope with gdrive_whoami.")
    return
  }

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
  BunTerminal.layer,
  FetchHttpClient.layer
)

BunRuntime.runMain(
  // oxlint-disable-next-line effecttsgo/strict-effect-provide -- this is the script's entry point
  Effect.provide(main, layer).pipe(Effect.tapCause((cause) => Console.error(report(cause)))),
  { disableErrorReporting: true }
)
