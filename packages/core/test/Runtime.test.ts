import { describe, it } from "@effect/vitest"
import * as Assert from "@effect/vitest/utils"
import { PluginApi } from "@scenesystems/amp-plugin-testing"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as Amp from "../src/Amp.ts"
import * as Runtime from "../src/Runtime.ts"
import * as Tool from "../src/Tool.ts"

class Greeting extends Context.Service<Greeting, { readonly prefix: string }>()("Greeting") {}

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

describe("Runtime.make", () => {
  it.live("provides Amp to the layer and to tools, and disposes the runtime when Amp disposes the plugin", () =>
    Effect.gen(function*() {
      const fake = PluginApi.make({ user: PluginApi.user("ari@acme.test") })
      const greeting = Layer.effect(Greeting)(
        Effect.map(Amp.Amp, (amp) => ({ prefix: `hello from ${amp.system.user?.email}` }))
      )
      const runtime = Runtime.make(fake.api, greeting)
      Tool.registerAll(fake.api, runtime, [Greet])

      Assert.strictEqual(
        yield* Effect.promise(() => fake.tool("greet").execute({ name: "ari" }, fake.toolContext)),
        "hello from ari@acme.test ari"
      )
      Assert.deepStrictEqual(fake.logs, [["greeting", "ari"]])

      Assert.strictEqual(fake.disposers(), 1)
      yield* Effect.promise(fake.dispose)
      // A disposed ManagedRuntime rejects further work; that is how we know dispose reached it.
      const exit = yield* Effect.exit(Effect.promise(() => runtime.runPromise(Effect.void)))
      Assert.assertTrue(exit._tag === "Failure", "expected the disposed runtime to refuse new work")
    }))

  it.live("surfaces a failing layer as a rendered defect on the first tool call instead of throwing at load", () =>
    Effect.gen(function*() {
      const fake = PluginApi.make()
      const broken = Layer.effect(Greeting)(Effect.fail(new Error("no such config")))
      const runtime = Runtime.make(fake.api, broken)
      Tool.registerAll(fake.api, runtime, [Greet])

      const result = yield* Effect.promise(() => fake.tool("greet").execute({ name: "x" }, fake.toolContext))
      Assert.assertTrue(typeof result === "string")
      Assert.assertMatch(result, /^Tool failed unexpectedly:\nError: no such config\n/)
      yield* Effect.promise(fake.dispose)
    }))
})
