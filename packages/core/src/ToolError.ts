/**
 * Error type for failures a tool wants to report back to the agent as text.
 *
 * Any failure whose value carries a string `message` (including `ToolError`,
 * `SchemaError`, and plain `Error`s) is rendered for the model by `Tool.toPluginTool`.
 * Use `ToolError` when you want to attach a remediation hint.
 *
 * @since 0.1.0
 */
import * as Data from "effect/Data"

/**
 * A recoverable tool failure with an actionable message for the agent.
 *
 * ```ts
 * yield* new ToolError({
 *   message: "GOOGLE_SERVICE_ACCOUNT_KEY is not set",
 *   hint: "Run `amp secrets set --workspace GOOGLE_SERVICE_ACCOUNT_KEY --secret`"
 * })
 * ```
 *
 * @since 0.1.0
 * @category errors
 */
export class ToolError extends Data.TaggedError("ToolError")<{
  readonly message: string
  readonly hint?: string | undefined
}> {}

/**
 * Renders an error value as text for the agent. Returns `undefined` when the
 * value carries no usable `message`, so callers can fall back to a full cause dump.
 *
 * @since 0.1.0
 * @category rendering
 */
export const render = (error: unknown): string | undefined => {
  if (error instanceof ToolError) {
    return error.hint === undefined ? `Error: ${error.message}` : `Error: ${error.message}\nHint: ${error.hint}`
  }
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") {
    const tag = "_tag" in error && typeof error._tag === "string" ? error._tag : "Error"
    return `${tag}: ${error.message}`
  }
  return undefined
}
