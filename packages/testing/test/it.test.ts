import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { describe, expect, FastCheck, it, TestClock, TestConsole } from "../src/index.ts"

describe("it.effect", () => {
  it.effect("controls time with TestClock", () =>
    Effect.gen(function*() {
      const fiber = yield* Effect.forkChild(Effect.sleep("1 hour").pipe(Effect.as("woke up")))
      yield* TestClock.adjust("1 hour")
      expect(yield* Fiber.join(fiber)).toBe("woke up")
    }))

  it.effect("captures console output with TestConsole", () =>
    Effect.gen(function*() {
      yield* Effect.log("hello")
      const lines = yield* TestConsole.logLines
      expect(lines.join("\n")).toContain("hello")
    }))

  it.effect("runs finalizers of the test scope", () =>
    Effect.gen(function*() {
      const scoped = Effect.acquireRelease(Effect.succeed("resource"), () => Effect.void)
      expect(yield* scoped).toBe("resource")
    }))

  it.effect.failing("reports Effect failures as test failures", () => Effect.fail("boom"))

  it.effect.each([1, 2, 3])("doubles %p", (n) => Effect.sync(() => expect(n * 2).toBe(n + n)))

  it.effect.skipIf(true)("is skipped", () => Effect.die("never runs"))
})

describe("it.live", () => {
  it.live("uses the real clock", () =>
    Effect.gen(function*() {
      const before = yield* Clock.currentTimeMillis
      yield* Effect.sleep("5 millis")
      const after = yield* Clock.currentTimeMillis
      expect(after - before).toBeGreaterThanOrEqual(4)
    }))
})

describe("it.prop", () => {
  it.prop(
    "accepts FastCheck arbitraries and Schemas",
    [FastCheck.integer(), Schema.String],
    ([n, s]) =>
      Effect.sync(() => {
        expect(Number.isInteger(n)).toBe(true)
        expect(typeof s).toBe("string")
      })
  )

  it.prop(
    "accepts a record of arbitraries",
    { n: Schema.Finite, list: FastCheck.array(FastCheck.boolean()) },
    ({ list, n }) =>
      Effect.sync(() => {
        expect(Number.isFinite(n)).toBe(true)
        expect(Array.isArray(list)).toBe(true)
      }),
    { fastCheck: { numRuns: 20 } }
  )
})

class Counter extends Context.Service<Counter, { readonly next: Effect.Effect<number> }>()("Counter") {}

const builds: Array<string> = []
const CounterLive = Layer.effect(Counter)(
  Effect.gen(function*() {
    yield* Effect.acquireRelease(
      Effect.sync(() => builds.push("acquire")),
      () => Effect.sync(() => builds.push("release"))
    )
    let n = 0
    return { next: Effect.sync(() => ++n) }
  })
)

it.layer(CounterLive)("it.layer", (it) => {
  it.effect("builds the layer once per suite", () =>
    Effect.gen(function*() {
      const counter = yield* Counter
      expect(yield* counter.next).toBe(1)
      expect(builds).toEqual(["acquire"])
    }))

  it.effect("shares the same instance across tests", () =>
    Effect.gen(function*() {
      const counter = yield* Counter
      expect(yield* counter.next).toBe(2)
    }))

  it.effect("still provides TestClock", () =>
    Effect.gen(function*() {
      const fiber = yield* Effect.forkChild(Effect.sleep("1 day"))
      yield* TestClock.adjust("1 day")
      yield* Fiber.join(fiber)
    }))

  class Doubled extends Context.Service<Doubled, { readonly next: Effect.Effect<number> }>()("Doubled") {}
  const DoubledLive = Layer.effect(Doubled)(
    Effect.map(Counter, (counter) => ({ next: Effect.map(counter.next, (n) => n * 2) }))
  )

  it.layer(DoubledLive)("nested layers reuse the parent's services", (it) => {
    it.effect("sees the parent Counter instance", () =>
      Effect.gen(function*() {
        const doubled = yield* Doubled
        expect(yield* doubled.next).toBe(6)
        expect(builds).toEqual(["acquire"])
      }))
  })
})

describe("after it.layer", () => {
  it.live("released the layer scope", () => Effect.sync(() => expect(builds).toEqual(["acquire", "release"])))
})
