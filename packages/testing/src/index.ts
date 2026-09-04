/**
 * Effect test helpers for `bun:test`.
 *
 * Mirrors the `@effect/vitest` API (`it.effect`, `it.live`, `it.layer`, `it.prop`) on top of Bun's test runner and
 * the runner-agnostic `effect/testing` modules, so plugin tests run on the same runtime Amp loads plugins into.
 *
 * @example
 * ```ts
 * import { describe, expect, it, TestClock } from "@scenesystems/amp-plugin-testing"
 *
 * describe("timers", () => {
 *   it.effect("fires after the clock advances", () =>
 *     Effect.gen(function*() {
 *       const fiber = yield* Effect.forkChild(Effect.sleep("1 minute"))
 *       yield* TestClock.adjust("1 minute")
 *       yield* Fiber.join(fiber)
 *     }))
 * })
 * ```
 */
import type { TestOptions } from "bun:test"
import * as B from "bun:test"
import * as Cause from "effect/Cause"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import * as fc from "effect/testing/FastCheck"
import * as TestClock from "effect/testing/TestClock"
import * as TestConsole from "effect/testing/TestConsole"

export { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
export * as FastCheck from "effect/testing/FastCheck"
export * as TestClock from "effect/testing/TestClock"
export * as TestConsole from "effect/testing/TestConsole"

/** Services every `it.effect` test can rely on. */
export type TestServices = TestClock.TestClock | TestConsole.TestConsole

/** `TestClock` (frozen at epoch, advanced with `TestClock.adjust`) plus `TestConsole` (captures console output). */
export const TestEnv: Layer.Layer<TestServices> = Layer.mergeAll(TestConsole.layer, TestClock.layer())

/** Bun's per-test timeout in milliseconds, or its full `TestOptions` (`timeout`, `retry`, `repeats`). */
export type Timeout = number | TestOptions

const hookTimeout = (timeout: Duration.Input | undefined) =>
  timeout === undefined ? undefined : Duration.toMillis(Duration.fromInputUnsafe(timeout))

/**
 * Runs an effect and turns a failure into a thrown `Error` with Effect's pretty stack traces, so Bun reports the
 * failure at the test site instead of a generic "promise rejected".
 */
const runTest = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromiseExit(effect).then((exit) => {
    if (Exit.isSuccess(exit)) return exit.value
    const errors = Cause.prettyErrors(exit.cause)
    if (errors.length === 1) throw errors[0]
    throw new AggregateError(errors, Cause.pretty(exit.cause))
  })

/** A single test whose body is an Effect requiring services `R`. */
export interface TestCase<R> {
  <A, E>(name: string, self: () => Effect.Effect<A, E, R>, timeout?: Timeout): void
}

export interface Tester<R> extends TestCase<R> {
  readonly skip: TestCase<R>
  readonly only: TestCase<R>
  /** Inverts the result: passes only when the effect fails. */
  readonly failing: TestCase<R>
  readonly skipIf: (condition: boolean) => TestCase<R>
  readonly runIf: (condition: boolean) => TestCase<R>
  /** One test per case; the case is passed to the body. */
  readonly each: <T>(
    cases: ReadonlyArray<T>
  ) => <A, E>(name: string, self: (case_: T) => Effect.Effect<A, E, R>, timeout?: Timeout) => void
}

const makeTester = <R>(
  mapEffect: <A, E>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E>,
  test: typeof B.test = B.test
): Tester<R> => {
  const run = <A, E>(self: () => Effect.Effect<A, E, R>) => runTest(mapEffect(Effect.suspend(self)))
  // Bun passes a `done` callback to any test function with a declared parameter; keep these zero-arity.
  const withTest = (t: typeof B.test): TestCase<R> => (name, self, timeout) => t(name, () => run(self), timeout)
  const f: TestCase<R> = withTest(test)
  return Object.assign(f, {
    skip: withTest(test.skip),
    only: withTest(test.only),
    failing: withTest(test.failing),
    skipIf: (condition: boolean) => withTest(test.skipIf(condition)),
    runIf: (condition: boolean) => withTest(test.if(condition)),
    each:
      <T>(cases: ReadonlyArray<T>) =>
      <A, E>(name: string, self: (case_: T) => Effect.Effect<A, E, R>, timeout?: Timeout) =>
        test.each(cases.map((case_) => [case_] as const))(name, (case_) => run(() => self(case_)), timeout)
  })
}

/** A FastCheck arbitrary or a Schema, which is turned into one with `Schema.toArbitrary`. */
export type ArbitraryInput = fc.Arbitrary<unknown> | Schema.Top

export type ArbitraryValue<A> = A extends fc.Arbitrary<infer T> ? T : A extends Schema.Top ? A["Type"] : never

export type ArbitraryValues<Arbs> = { readonly [K in keyof Arbs]: ArbitraryValue<Arbs[K]> }

export type PropOptions = Timeout | (TestOptions & { readonly fastCheck?: fc.Parameters<unknown> })

/** A property-based test: FastCheck generates inputs, the Effect body must succeed for all of them. */
export interface PropTester<R> {
  <const Arbs extends ReadonlyArray<ArbitraryInput> | Readonly<Record<string, ArbitraryInput>>, A, E>(
    name: string,
    arbitraries: Arbs,
    self: (values: ArbitraryValues<Arbs>) => Effect.Effect<A, E, R>,
    options?: PropOptions
  ): void
}

const toArbitrary = (input: ArbitraryInput): fc.Arbitrary<unknown> =>
  Schema.isSchema(input) ? Schema.toArbitrary(input)(fc) : input

/** A tuple of inputs becomes `fc.tuple`, a record becomes `fc.record`; the generated value has the same shape. */
const toArbitraries = (
  arbitraries: ReadonlyArray<ArbitraryInput> | Readonly<Record<string, ArbitraryInput>>
): fc.Arbitrary<unknown> =>
  Array.isArray(arbitraries)
    ? fc.tuple(...arbitraries.map(toArbitrary))
    : fc.record(Object.fromEntries(Object.entries(arbitraries).map(([key, input]) => [key, toArbitrary(input)])))

const makeProp =
  <R>(mapEffect: <A, E>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E>): PropTester<R> =>
  (name, arbitraries, self, options) => {
    const arbitrary = toArbitraries(arbitraries)
    const parameters = typeof options === "object" && "fastCheck" in options ? options.fastCheck : undefined
    B.test(
      name,
      () =>
        fc.assert(
          fc.asyncProperty(arbitrary, (values) =>
            runTest(
              mapEffect(
                // `toArbitraries` preserves the shape of `arbitraries`, which is what `ArbitraryValues` describes.
                // oxlint-disable-next-line typescript/no-unsafe-type-assertion
                Effect.asVoid(Effect.suspend(() => self(values as ArbitraryValues<typeof arbitraries>)))
              )
            )),
          parameters
        ),
      options
    )
  }

export interface LayerOptions {
  /** Timeout for building the layer (`beforeAll`) and closing its scope (`afterAll`). */
  readonly timeout?: Duration.Input
  readonly memoMap?: Layer.MemoMap
}

/** The `it` handed to an `it.layer(...)` suite: every test can use the shared layer's services `R`. */
export interface LayerTester<R> {
  readonly effect: Tester<R | TestServices | Scope.Scope>
  readonly prop: PropTester<R | TestServices | Scope.Scope>
  readonly layer: <R2, E2>(
    layer: Layer.Layer<R2, E2, R | TestServices>,
    options?: LayerOptions
  ) => (name: string, f: (it: LayerTester<R | R2>) => void) => void
}

/**
 * Builds `layer_` once for a `describe` block (in `beforeAll`) and releases it in `afterAll`. Layers are memoized, so
 * nested `it.layer` calls share already-built services with the parent suite.
 */
export const layer = <R, E>(layer_: Layer.Layer<R, E>, options?: LayerOptions) => {
  const withTestEnv: Layer.Layer<R | TestServices, E> = Layer.provideMerge(layer_, TestEnv)
  const memoMap = options?.memoMap ?? Layer.makeMemoMapUnsafe()
  const scope = Scope.makeUnsafe()
  const context = Layer.buildWithMemoMap(withTestEnv, memoMap, scope).pipe(Effect.orDie, Effect.cached, Effect.runSync)
  const provide = <A, E2>(effect: Effect.Effect<A, E2, R | TestServices | Scope.Scope>): Effect.Effect<A, E2> =>
    Effect.flatMap(context, (context) => effect.pipe(Effect.scoped, Effect.provide(context)))
  const it: LayerTester<R> = {
    effect: makeTester(provide),
    prop: makeProp(provide),
    layer: (nested, nestedOptions) =>
      layer(Layer.provideMerge(nested, withTestEnv), {
        ...nestedOptions,
        memoMap: Layer.forkMemoMapUnsafe(memoMap)
      })
  }
  return (name: string, f: (it: LayerTester<R>) => void): void => {
    B.describe(name, () => {
      B.beforeAll(() => runTest(Effect.asVoid(context)), hookTimeout(options?.timeout))
      B.afterAll(() => runTest(Scope.close(scope, Exit.void)), hookTimeout(options?.timeout))
      f(it)
    })
  }
}

const withTestEnv = <A, E>(effect: Effect.Effect<A, E, TestServices | Scope.Scope>): Effect.Effect<A, E> =>
  // Each test is its own entry point, so providing the layer here is the intended place.
  // oxlint-disable-next-line effecttsgo/strict-effect-provide
  effect.pipe(Effect.scoped, Effect.provide(TestEnv))

const live = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>): Effect.Effect<A, E> => Effect.scoped(effect)

export const it: {
  /** Runs the effect with `TestEnv`: a controllable `TestClock` and a capturing `TestConsole`. */
  readonly effect: Tester<TestServices | Scope.Scope>
  /** Runs the effect against the real clock and console. */
  readonly live: Tester<Scope.Scope>
  readonly layer: typeof layer
  readonly prop: PropTester<TestServices | Scope.Scope>
} = {
  effect: makeTester(withTestEnv),
  live: makeTester(live),
  layer,
  prop: makeProp(withTestEnv)
}
