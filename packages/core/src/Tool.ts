/**
 * Define Amp tools as Effects with `Schema`-typed input, then register them
 * against a `ManagedRuntime` built from the plugin's `Layer`.
 *
 * ```ts
 * const Echo = Tool.make({
 *   name: "echo",
 *   description: "Echo the message back",
 *   input: Schema.Struct({ message: Schema.String }),
 *   execute: ({ message }) => Effect.succeed(message)
 * })
 *
 * export default function(api: PluginAPI) {
 *   const runtime = Runtime.make(api, MyServices.layer)
 *   Tool.registerAll(api, runtime, [Echo])
 * }
 * ```
 *
 * @since 0.1.0
 */
import type {
  PluginAPI,
  PluginToolContext,
  PluginToolDefinition,
  PluginToolResult,
  Subscription
} from "@ampcode/plugin"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import type * as ManagedRuntime from "effect/ManagedRuntime"
import * as Schema from "effect/Schema"
import * as SchemaAST from "effect/SchemaAST"
import * as ToolError from "./ToolError.ts"

/**
 * Schemas usable as tool input: any schema whose decoding needs no services,
 * so decoding can run on the plugin runtime without widening its requirements.
 *
 * @since 0.1.0
 * @category models
 */
export type InputSchema = Schema.Top & { readonly "DecodingServices": never }

/**
 * An Amp tool whose input is decoded with `input` and whose body is an Effect.
 *
 * @since 0.1.0
 * @category models
 */
export interface Tool<in out S extends InputSchema, out E, out R> {
  /** Tool name (must match ^[a-zA-Z0-9_-]+$). Sent to the LLM. */
  readonly name: string
  /** Display title shown in Amp clients instead of the raw name. Not sent to the LLM. */
  readonly title?: string | undefined
  /** Labels grouping adjacent calls into one transcript row. Not sent to the LLM. */
  readonly transcriptGroup?: PluginToolDefinition["transcriptGroup"] | undefined
  /** Description shown to the LLM. */
  readonly description: string
  /**
   * Input schema. Its JSON Schema is sent to the LLM; decoding failures are reported as text.
   * Use `Schema.Finite` rather than `Schema.Number` for numeric fields: `Schema.Number` admits
   * `NaN`/`Infinity` and so does not serialise to a plain JSON Schema `number`.
   */
  readonly input: S
  /** Tool body. Failures are rendered for the agent; defects are reported with their cause. */
  readonly execute: (input: S["Type"], ctx: PluginToolContext) => Effect.Effect<PluginToolResult, E, R>
}

/**
 * Identity constructor that pins type inference for a tool definition.
 *
 * @since 0.1.0
 * @category constructors
 */
export const make = <S extends InputSchema, E, R>(tool: Tool<S, E, R>): Tool<S, E, R> => tool

/**
 * JSON Schema for a tool input, in the shape `PluginToolDefinition.inputSchema` expects.
 *
 * Named schemas are inlined so the result is a single self-contained object;
 * tool schemas are small and Amp does not resolve `$defs`.
 *
 * @since 0.1.0
 * @category conversions
 */
export const toInputSchema = (schema: Schema.Top): PluginToolDefinition["inputSchema"] => {
  const document = Schema.toJsonSchemaDocument(schema, { referencePolicy: () => undefined })
  const { $schema: _dialect, ...rest } = document.schema as Record<string, unknown>
  // `Schema.Struct({})` accepts any non-null object and renders as `anyOf: [object, array]`;
  // a tool without parameters is just an empty object schema.
  if (SchemaAST.isObjects(schema.ast) && schema.ast.propertySignatures.length === 0) {
    const { anyOf: _any, ...bare } = rest
    return { ...bare, type: "object", properties: {} }
  }
  return { ...rest, type: "object" }
}

/**
 * Renders a failed `Cause` as tool result text. Typed failures with a `message`
 * are shown tersely; anything else (defects, interruptions) gets the full pretty cause.
 *
 * @since 0.1.0
 * @category rendering
 */
export const renderCause = <E>(cause: Cause.Cause<E>): string => {
  for (const reason of cause.reasons) {
    if (Cause.isFailReason(reason)) {
      const rendered = ToolError.render(reason.error)
      if (rendered !== undefined) return rendered
    }
  }
  return `Tool failed unexpectedly:\n${Cause.pretty(cause)}`
}

/**
 * Converts a `Tool` into a `PluginToolDefinition` that runs on `runtime`.
 *
 * Input is decoded before `execute` runs; decode errors, typed failures, defects,
 * and failures building the runtime's layer all come back to the agent as text so
 * a tool call never rejects.
 *
 * @since 0.1.0
 * @category conversions
 */
export const toPluginTool =
  <R>(runtime: ManagedRuntime.ManagedRuntime<R, never>) =>
  <S extends InputSchema, E>(tool: Tool<S, E, R>): PluginToolDefinition => {
    const decode = Schema.decodeUnknownEffect(tool.input)
    const definition: PluginToolDefinition = {
      name: tool.name,
      description: tool.description,
      inputSchema: toInputSchema(tool.input),
      // `runPromiseExit` rather than `runPromise`: building the runtime's layer happens outside the
      // effect, so a layer failure would otherwise reject the promise instead of reaching `catchCause`.
      execute: (raw, ctx) =>
        runtime.runPromiseExit(
          Effect.flatMap(decode(raw), (input) => tool.execute(input, ctx)).pipe(
            Effect.withSpan(`tool.${tool.name}`)
          )
        ).then((exit) => Exit.isSuccess(exit) ? exit.value : renderCause(exit.cause))
    }
    if (tool.title !== undefined) definition.title = tool.title
    if (tool.transcriptGroup !== undefined) definition.transcriptGroup = tool.transcriptGroup
    return definition
  }

/**
 * Registers every tool with Amp. The returned subscription disposes all of them.
 *
 * @since 0.1.0
 * @category registration
 */
export const registerAll = <R>(
  api: PluginAPI,
  runtime: ManagedRuntime.ManagedRuntime<R, never>,
  tools: ReadonlyArray<Tool<any, any, R>>
): Subscription => {
  const convert = toPluginTool(runtime)
  const subscriptions = tools.map((tool) => api.registerTool(convert(tool)))
  return {
    unsubscribe: () => {
      for (const subscription of subscriptions) subscription.unsubscribe()
    }
  }
}
