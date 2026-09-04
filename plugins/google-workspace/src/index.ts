/**
 * Google Workspace plugin for Amp: Drive search, Docs as Markdown, Sheets ranges, comments.
 *
 * This is the Effect skeleton; the tool set is ported from the prototype incrementally.
 * Every tool is an Effect (`Tool.make`) run on a `ManagedRuntime` built from `layer`.
 *
 * @since 0.1.0
 */
import type { PluginAPI } from "@ampcode/plugin"
import { Amp, Runtime, Tool } from "@scenesystems/amp-plugin-core"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

// Amp reads this statically: it must stay a plain string literal of at most 300 characters.
export const description =
  "Google Drive, Docs, and Sheets tools: search Drive, read Docs as Markdown, read/write Sheet ranges, and review or add comments. Configure via GOOGLE_SERVICE_ACCOUNT_KEY or GOOGLE_OAUTH_* secrets."

/**
 * Services required by the tools. Google auth and API clients are added here as they are ported.
 */
const layer = Layer.empty

const Whoami = Tool.make({
  name: "gdrive_whoami",
  title: "Check Google credentials",
  description:
    "Report which Amp user this plugin runs as and which Google credential it will use. Use this first when a Drive/Docs/Sheets tool fails with a permission error.",
  input: Schema.Struct({}),
  execute: () =>
    Effect.gen(function*() {
      const amp = yield* Amp.Amp
      const user = amp.system.user
      return [
        `Amp user: ${user?.email ?? "unknown"}${user?.workspace ? ` (workspace ${user.workspace.name})` : ""}`,
        "Google credential: not configured yet (Effect port in progress)"
      ].join("\n")
    })
})

export default function(api: PluginAPI): void {
  const runtime = Runtime.make(api, layer)
  Tool.registerAll(api, runtime, [Whoami])
  api.logger.log("google-workspace plugin loaded")
}
