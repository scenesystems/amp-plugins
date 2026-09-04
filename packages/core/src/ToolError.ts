/**
 * Error type for failures a tool wants to report back to the agent as text.
 *
 * Any failure whose value carries a string `message` (including `ToolError`,
 * `SchemaError`, and plain `Error`s) is rendered for the model by `Tool.toPluginTool`.
 * Use `ToolError` when you want to attach a remediation hint.
 */
import * as Data from "effect/Data"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"

/**
 * A string property read through the prototype chain, because Effect's own errors (for example
 * `SchemaError`) expose `message` as a getter rather than an own property.
 */
const stringProperty = (key: string) => (value: unknown): Option.Option<string> =>
  Predicate.hasProperty(value, key) && Predicate.isString(value[key]) ? Option.some(value[key]) : Option.none()
const messageOf = stringProperty("message")
const tagOf = stringProperty("_tag")

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
 * @category errors
 */
export class ToolError extends Data.TaggedError("ToolError")<{
  readonly message: string
  readonly hint?: string | undefined
}> {}

/**
 * Renders an error value as text for the agent. `None` when the value carries no
 * usable `message`, so callers can fall back to a full cause dump.
 *
 * @category rendering
 */
export const render = (error: unknown): Option.Option<string> => {
  if (error instanceof ToolError) {
    return Option.some(
      error.hint === undefined ? `Error: ${error.message}` : `Error: ${error.message}\nHint: ${error.hint}`
    )
  }
  return Option.map(messageOf(error), (message) => `${Option.getOrElse(tagOf(error), () => "Error")}: ${message}`)
}
