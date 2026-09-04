import { describe, it } from "@effect/vitest"
import * as Assert from "@effect/vitest/utils"
import { Assert as ExitAssert, PluginApi } from "@scenesystems/amp-plugin-testing"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as ManagedRuntime from "effect/ManagedRuntime"
import * as Schema from "effect/Schema"
import * as Tool from "../src/Tool.ts"
import { ToolError } from "../src/ToolError.ts"

const runtime = ManagedRuntime.make(Layer.empty)
const ctx = PluginApi.make().toolContext

const Echo = Tool.make({
  name: "echo",
  title: "Echo",
  transcriptGroup: { active: "Echoing", complete: "Echoed" },
  description: "Echo the message back, optionally repeated",
  input: Schema.Struct({
    message: Schema.String.annotate({ description: "Text to echo" }),
    times: Schema.optionalKey(Schema.Finite).annotate({ description: "Repetitions" })
  }),
  execute: ({ message, times }) => Effect.succeed(message.repeat(times ?? 1))
})

const tool = <S extends Tool.InputSchema, E>(definition: Tool.Tool<S, E, never>) =>
  Tool.toPluginTool(runtime)(definition)

const run = (definition: Tool.Tool<any, any, never>, input: Record<string, unknown>) =>
  Effect.promise(() => tool(definition).execute(input, ctx))

describe("Tool.toInputSchema", () => {
  it("renders a struct as a self-contained object schema without a dialect", () => {
    Assert.deepStrictEqual(Tool.toInputSchema(Echo.input), {
      type: "object",
      properties: {
        message: { type: "string", description: "Text to echo" },
        times: { type: "number", description: "Repetitions" }
      },
      required: ["message"],
      additionalProperties: false
    })
  })

  it("renders a parameterless tool as an empty object schema", () => {
    Assert.deepStrictEqual(Tool.toInputSchema(Schema.Struct({})), { type: "object", properties: {} })
  })

  it("inlines named schemas instead of emitting $defs", () => {
    class Named extends Schema.Class<Named>("Named")({ id: Schema.String }) {}
    const schema = Tool.toInputSchema(Schema.Struct({ item: Named }))
    Assert.deepStrictEqual(Object.keys(schema).sort(), ["additionalProperties", "properties", "required", "type"])
    Assert.deepStrictEqual(schema.properties, {
      item: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false
      }
    })
  })
})

describe("Tool.toPluginTool", () => {
  it("copies name, title, transcript group, description, and schema", () => {
    const definition = tool(Echo)
    Assert.deepStrictEqual(
      { ...definition, execute: undefined },
      {
        name: "echo",
        title: "Echo",
        transcriptGroup: { active: "Echoing", complete: "Echoed" },
        description: "Echo the message back, optionally repeated",
        inputSchema: Tool.toInputSchema(Echo.input),
        execute: undefined
      }
    )
  })

  it("omits title and transcriptGroup when the tool has none", () => {
    const Bare = Tool.make({
      name: "bare",
      description: "Bare",
      input: Schema.Struct({}),
      execute: () => Effect.succeed("")
    })
    const definition = tool(Bare)
    Assert.deepStrictEqual(Object.keys(definition).sort(), ["description", "execute", "inputSchema", "name"])
  })

  it.effect("decodes input and runs the effect", () =>
    Effect.gen(function*() {
      Assert.strictEqual(yield* run(Echo, { message: "ab", times: 2 }), "abab")
      Assert.strictEqual(yield* run(Echo, { message: "ab" }), "ab")
    }))

  it.effect("reports each kind of decode failure as text instead of rejecting", () =>
    Effect.gen(function*() {
      Assert.strictEqual(yield* run(Echo, { message: 42 }), "SchemaError: Expected string\n  at [\"message\"]")
      Assert.strictEqual(yield* run(Echo, {}), "SchemaError: Missing key\n  at [\"message\"]")
      Assert.strictEqual(
        yield* run(Echo, { message: "x", times: "2" }),
        "SchemaError: Expected number\n  at [\"times\"]"
      )
    }))

  it.effect("renders a ToolError with and without its hint", () =>
    Effect.gen(function*() {
      const failing = (hint: string | undefined) =>
        Tool.make({
          name: "failing",
          description: "Always fails",
          input: Schema.Struct({}),
          execute: () => new ToolError({ message: "no credentials", hint })
        })
      Assert.strictEqual(
        yield* run(failing("set GOOGLE_SERVICE_ACCOUNT_KEY"), {}),
        "Error: no credentials\nHint: set GOOGLE_SERVICE_ACCOUNT_KEY"
      )
      Assert.strictEqual(yield* run(failing(undefined), {}), "Error: no credentials")
    }))

  it.effect("renders defects with the pretty cause, keeping the defect's message and stack", () =>
    Effect.gen(function*() {
      const Dying = Tool.make({
        name: "dying",
        description: "Throws",
        input: Schema.Struct({}),
        execute: () =>
          Effect.sync(() => {
            throw new Error("kaboom")
          })
      })
      const result = yield* run(Dying, {})
      Assert.assertTrue(typeof result === "string")
      Assert.assertMatch(result, /^Tool failed unexpectedly:\nError: kaboom\n {4}at /)
    }))

  it.effect("never rejects: the promise resolves even for a defect", () =>
    Effect.gen(function*() {
      const exit = yield* Effect.exit(run(
        Tool.make({ name: "d", description: "d", input: Schema.Struct({}), execute: () => Effect.die("x") }),
        {}
      ))
      Assert.assertTrue(exit._tag === "Success")
    }))
})

describe("Tool.renderCause", () => {
  it("renders typed failures tersely and everything else with the full cause", () => {
    Assert.strictEqual(Tool.renderCause(Cause.fail(new ToolError({ message: "m", hint: "h" }))), "Error: m\nHint: h")
    Assert.strictEqual(Tool.renderCause(Cause.fail(new Error("plain error"))), "Error: plain error")
    Assert.strictEqual(Tool.renderCause(Cause.fail({ _tag: "Custom", message: "objecty" })), "Custom: objecty")
    Assert.strictEqual(Tool.renderCause(Cause.fail({ message: "untagged" })), "Error: untagged")
    Assert.assertMatch(
      Tool.renderCause(Cause.fail("plain string")),
      /^Tool failed unexpectedly:\nError: plain string\n/
    )
    Assert.assertMatch(Tool.renderCause(Cause.die("boom")), /^Tool failed unexpectedly:\nError: boom\n/)
    Assert.assertMatch(Tool.renderCause(Cause.interrupt()), /^Tool failed unexpectedly:\nInterruptError: /)
  })

  it("prefers the first renderable typed failure when a cause has several reasons", () => {
    const cause = Cause.combine(Cause.die("boom"), Cause.fail(new ToolError({ message: "typed" })))
    Assert.strictEqual(Tool.renderCause(cause), "Error: typed")
  })
})

describe("Tool.registerAll", () => {
  it.effect("registers every tool in order and unsubscribes all of them at once", () =>
    Effect.gen(function*() {
      const fake = PluginApi.make()
      const Second = Tool.make({
        name: "second",
        description: "2",
        input: Schema.Struct({}),
        execute: () => Effect.succeed("")
      })
      const subscription = Tool.registerAll(fake.api, runtime, [Echo, Second])
      Assert.deepStrictEqual(fake.tools.map((t) => t.name), ["echo", "second"])
      Assert.strictEqual(
        yield* Effect.promise(() => fake.tool("echo").execute({ message: "hi" }, fake.toolContext)),
        "hi"
      )
      subscription.unsubscribe()
      Assert.deepStrictEqual(fake.tools, [])
    }))
})

describe("Tool.make", () => {
  it.effect("execute is a plain Effect whose failure is observable as a typed failure", () =>
    Effect.gen(function*() {
      Assert.strictEqual(yield* Echo.execute({ message: "hi", times: 3 }, ctx), "hihihi")
      const Failing = Tool.make({
        name: "f",
        description: "f",
        input: Schema.Struct({}),
        execute: () => new ToolError({ message: "typed" })
      })
      ExitAssert.assertFails(yield* Effect.exit(Failing.execute({}, ctx)), new ToolError({ message: "typed" }))
    }))
})
