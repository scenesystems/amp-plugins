/**
 * Google Workspace plugin for Amp: Drive search, Docs as Markdown, Sheets ranges, comments.
 *
 * Every tool is an Effect (`Tool.make`) run on a `ManagedRuntime` built from `layer`.
 *
 * @since 0.1.0
 */
import type { PluginAPI } from "@ampcode/plugin"
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem"
import { type Amp, Runtime, Tool, ToolError } from "@scenesystems/amp-plugin-core"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import * as Credential from "./Credential.ts"
import * as Google from "./Google.ts"
import * as GoogleAuth from "./GoogleAuth.ts"
import * as Tools from "./Tools.ts"

// Amp reads this statically: it must stay a plain string literal of at most 300 characters.
export const description =
  "Google Drive, Docs, and Sheets tools: search Drive, read Docs as Markdown, read/write Sheet ranges, and review or add comments. Configure via GOOGLE_SERVICE_ACCOUNT_KEY or GOOGLE_OAUTH_* secrets."

/**
 * Services the tools run against: the Google API client over `GoogleAuth` over Effect's fetch client
 * and Bun's file system (for `GOOGLE_SERVICE_ACCOUNT_KEY_FILE`).
 *
 * @since 0.1.0
 * @category layers
 */
export const layer: Layer.Layer<Tools.Services, never, Amp.Amp> = Google.layer.pipe(
  Layer.provideMerge(GoogleAuth.layer),
  Layer.provide([FetchHttpClient.layer, BunFileSystem.layer])
)

/**
 * Body of the `check-credentials` command: the resolved credential and the identity Drive sees,
 * or the rendered configuration problem. Never fails; every error becomes text for the user.
 *
 * @since 0.1.0
 * @category commands
 */
export const checkCredentials: Effect.Effect<string, never, Tools.Services> = Effect.gen(function*() {
  const auth = yield* GoogleAuth.GoogleAuth
  const google = yield* Google.Google
  const credential = yield* auth.credential
  const about = yield* google.about
  return `Google Workspace: ${Credential.describe(credential)} → Drive sees ${about.user?.emailAddress ?? "unknown"}`
}).pipe(
  Tools.explain,
  Effect.catchTag("ToolError", (error) => Effect.succeed(ToolError.render(error) ?? error.message))
)

export default function(api: PluginAPI): void {
  const runtime = Runtime.make(api, layer)
  Tool.registerAll(api, runtime, Tools.all)

  api.registerCommand(
    "check-credentials",
    {
      title: "check Google credentials",
      category: "google-workspace",
      description: "Verify the Google service account / OAuth credentials and show the identity Drive sees."
    },
    (ctx) =>
      runtime.runPromise(Effect.flatMap(checkCredentials, (message) => Effect.promise(() => ctx.ui.notify(message))))
  )

  void api.registerSkill({ path: "skills/google-workspace" })
  api.logger.log("google-workspace plugin loaded")
}
