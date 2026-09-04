/**
 * Assertions about how an Effect ended, on top of `@effect/vitest/utils`.
 *
 * The plugins' whole error story is "render a typed failure to the agent instead of crashing", so
 * negative tests must prove that a program failed with exactly one *typed* error and nothing else:
 * no defect, no interruption, no second failure hiding behind the first. `Effect.flip` cannot tell
 * those apart; these helpers can.
 *
 * `assertExitFailure(exit, Cause.fail(error))` from `@effect/vitest/utils` is not used because a
 * failure that passes through `Effect.withSpan` carries a stack-trace annotation on its `Fail`
 * reason, so two structurally equal causes are never `Equal.equals`. Comparing the extracted error
 * with `assertEquals` (which understands `Equal`, `Option`, `Redacted`, and `Data` errors) is exact
 * and stable.
 *
 * Every failure path goes through `assertTrue`, so a failed expectation is a vitest `AssertionError`
 * with the message below, never a bare exception.
 */
import * as Assert from "@effect/vitest/utils"
import * as Arr from "effect/Array"
import * as Cause from "effect/Cause"
import * as Exit from "effect/Exit"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { inspect } from "node:util"

const show = (value: unknown): string => inspect(value, { depth: 6, breakLength: 120 })

const onlyReason = <A, E>(
  exit: Exit.Exit<A, E>,
  expectation: string
): { readonly reason: Cause.Reason<E>; readonly cause: Cause.Cause<E> } => {
  Assert.assertTrue(
    Exit.isFailure(exit),
    `Expected ${expectation}, but the effect succeeded with:\n${Exit.isSuccess(exit) ? show(exit.value) : ""}`
  )
  const cause = exit.cause
  const only = Option.filter(Arr.head(cause.reasons), () => cause.reasons.length === 1)
  Assert.assertTrue(
    Option.isSome(only),
    `Expected ${expectation} as the only reason, but the cause has ${cause.reasons.length}:\n${Cause.pretty(cause)}`
  )
  return { reason: only.value, cause }
}

/**
 * The single typed failure of `exit`.
 *
 * Fails the test when the effect succeeded, died, was interrupted, or failed for more than one reason.
 *
 * @category extractors
 */
export const failureOf = <A, E>(exit: Exit.Exit<A, E>): E => {
  const { cause, reason } = onlyReason(exit, "a typed failure")
  Assert.assertTrue(
    Cause.isFailReason(reason),
    `Expected a typed failure but got a ${reason._tag}:\n${Cause.pretty(cause)}`
  )
  return reason.error
}

/**
 * The single defect of `exit`.
 *
 * Fails the test when the effect succeeded, failed with a typed error, was interrupted, or died for
 * more than one reason.
 *
 * @category extractors
 */
export const defectOf = <A, E>(exit: Exit.Exit<A, E>): unknown => {
  const { cause, reason } = onlyReason(exit, "a defect")
  Assert.assertTrue(Cause.isDieReason(reason), `Expected a defect but got a ${reason._tag}:\n${Cause.pretty(cause)}`)
  return reason.defect
}

/**
 * Asserts that `exit` failed with exactly `expected` and nothing else.
 *
 * Equality is `Equal.equals`, so `Data.TaggedError` instances compare by their fields (including
 * `hint`), `Option`s by content, and `Redacted` values by the secret they wrap.
 *
 * @category assertions
 */
export const assertFails = <A, E>(exit: Exit.Exit<A, E>, expected: E, message?: string): void => {
  Assert.assertEquals(failureOf(exit), expected, message)
}

/**
 * Asserts that `exit` succeeded with exactly `expected`, using `Equal.equals`.
 *
 * @category assertions
 */
export const assertSucceeds = <A, E>(exit: Exit.Exit<A, E>, expected: A, message?: string): void => {
  Assert.assertTrue(
    Exit.isSuccess(exit),
    `Expected success with ${show(expected)}, but the effect failed:\n${
      Exit.isFailure(exit) ? Cause.pretty(exit.cause) : ""
    }`
  )
  Assert.assertEquals(exit.value, expected, message)
}

/** JSON text for any value that has one; `None` for cyclic, BigInt, or `undefined` values. */
const toJson = Schema.encodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

/**
 * Asserts that none of `secrets` appears when `value` is rendered the way a log line, an error
 * message, or a thrown exception would render it (`node:util` `inspect`, `String(value)`, and JSON).
 *
 * @category assertions
 */
export const assertRedacted = (value: unknown, secrets: ReadonlyArray<string>): void => {
  const renderings = [inspect(value, { depth: null }), String(value), ...Arr.fromOption(toJson(value))]
  Arr.forEach(secrets, (secret) => {
    Assert.assertTrue(secret !== "", "assertRedacted needs non-empty secrets to search for")
    Arr.forEach(renderings, (rendered) => {
      Assert.assertFalse(rendered.includes(secret), `Secret ${show(secret)} leaked into the rendering:\n${rendered}`)
    })
  })
}
