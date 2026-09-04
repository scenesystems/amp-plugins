import type { PluginAPI, PluginToolContext, PluginToolDefinition } from "@ampcode/plugin"
import { describe, expect, it, test } from "@scenesystems/amp-plugin-testing"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as ManagedRuntime from "effect/ManagedRuntime"
import * as Schema from "effect/Schema"
import * as Amp from "../src/Amp.ts"
import * as Runtime from "../src/Runtime.ts"
import * as Tool from "../src/Tool.ts"
import { ToolError } from "../src/ToolError.ts"

const ctx = {} as PluginToolContext
const runtime = ManagedRuntime.make(Layer.empty)

const Echo = Tool.make({
  name: "echo",
  title: "Echo",
  description: "Echo the message back, optionally repeated",
  input: Schema.Struct({
    message: Schema.String.annotate({ description: "Text to echo" }),
    times: Schema.optionalKey(Schema.Finite)
  }),
  execute: ({ message, times }) => Effect.succeed(message.repeat(times ?? 1))
})

describe("Tool.toInputSchema", () => {
  test("produces an object JSON Schema with properties and required", () => {
    const schema = Tool.toInputSchema(Echo.input)
    expect(schema.type).toBe("object")
    expect(schema.required).toEqual(["message"])
    expect(schema.properties).toMatchObject({
      message: { type: "string", description: "Text to echo" },
      times: { type: "number" }
    })
    expect(schema).not.toHaveProperty("$schema")
  })

  test("renders a parameterless tool as an empty object schema", () => {
    const schema = Tool.toInputSchema(Schema.Struct({}))
    expect(schema).toEqual({ type: "object", properties: {} })
  })
})

describe("Tool.toPluginTool", () => {
  const definition = Tool.toPluginTool(runtime)(Echo)

  test("copies metadata", () => {
    expect(definition.name).toBe("echo")
    expect(definition.title).toBe("Echo")
    expect(definition.description).toBe(Echo.description)
  })

  test("decodes input and runs the effect", async () => {
    expect(await definition.execute({ message: "ab", times: 2 }, ctx)).toBe("abab")
  })

  test("reports decode failures as text instead of rejecting", async () => {
    const result = await definition.execute({ message: 42 }, ctx)
    expect(typeof result).toBe("string")
    expect(result).toStartWith("SchemaError:")
    expect(result).toContain("string")
  })

  test("renders ToolError with its hint", async () => {
    const Failing = Tool.make({
      name: "failing",
      description: "Always fails",
      input: Schema.Struct({}),
      execute: () => new ToolError({ message: "no credentials", hint: "set GOOGLE_SERVICE_ACCOUNT_KEY" })
    })
    expect(await Tool.toPluginTool(runtime)(Failing).execute({}, ctx)).toBe(
      "Error: no credentials\nHint: set GOOGLE_SERVICE_ACCOUNT_KEY"
    )
  })

  test("renders defects with the pretty cause", async () => {
    const Dying = Tool.make({
      name: "dying",
      description: "Throws",
      input: Schema.Struct({}),
      execute: () =>
        Effect.sync(() => {
          throw new Error("kaboom")
        })
    })
    const result = await Tool.toPluginTool(runtime)(Dying).execute({}, ctx)
    expect(result).toStartWith("Tool failed unexpectedly:")
    expect(result).toContain("kaboom")
  })
})

describe("Tool.make", () => {
  it.effect("execute is a plain Effect that can run under the test environment", () =>
    Effect.gen(function*() {
      expect(yield* Echo.execute({ message: "hi", times: 3 }, ctx)).toBe("hihihi")
    }))
})

/** A fake `PluginAPI` that records registrations, dispose callbacks, and log calls. */
const makeFakeApi = () => {
  const registered: Array<PluginToolDefinition> = []
  const disposers: Array<() => void | Promise<void>> = []
  const logs: Array<unknown> = []
  const api = {
    logger: { log: (...args: Array<unknown>) => logs.push(args) },
    registerTool: (definition: PluginToolDefinition) => {
      registered.push(definition)
      return { unsubscribe: () => {} }
    },
    onDispose: (callback: () => void | Promise<void>) => {
      disposers.push(callback)
      return { unsubscribe: () => {} }
    }
  } as unknown as PluginAPI
  return { api, registered, disposers, logs }
}

describe("Runtime.make + Tool.registerAll", () => {
  it.live("provides Amp to tools and disposes on plugin dispose", () =>
    Effect.gen(function*() {
      const { api, disposers, logs, registered } = makeFakeApi()

      class Greeting extends Context.Service<Greeting, { readonly prefix: string }>()("Greeting", {
        make: Effect.map(Amp.Amp, (amp) => ({ prefix: typeof amp.logger.log === "function" ? "hello" : "?" }))
      }) {}

      const Greet = Tool.make({
        name: "greet",
        description: "Greets",
        input: Schema.Struct({ name: Schema.String }),
        execute: ({ name }) =>
          Effect.gen(function*() {
            const { prefix } = yield* Greeting
            yield* Amp.log("greeting", name)
            return `${prefix} ${name}`
          })
      })

      const runtime = Runtime.make(api, Layer.effect(Greeting)(Greeting.make))
      Tool.registerAll(api, runtime, [Greet])

      expect(registered.map((d) => d.name)).toEqual(["greet"])
      expect(yield* Effect.promise(() => registered[0]!.execute({ name: "ari" }, ctx))).toBe("hello ari")
      expect(logs).toEqual([["greeting", "ari"]])
      expect(disposers).toHaveLength(1)
      yield* Effect.promise(async () => disposers[0]!())
    }))
})
