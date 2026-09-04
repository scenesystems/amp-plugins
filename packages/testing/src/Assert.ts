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
 * @since 0.2.0
 */
import * as Assert from "@effect/vitest/utils"
import * as Cause from "effect/Cause"
import * as Exit from "effect/Exit"
import { inspect } from "node:util"

const show = (value: unknown): string => inspect(value, { depth: 6, breakLength: 120 })

const onlyReason = <A, E>(
  exit: Exit.Exit<A, E>,
  expectation: string
): { readonly reason: Cause.Reason<E>; readonly cause: Cause.Cause<E> } => {
  if (!Exit.isFailure(exit)) {
    throw new Error(`Expected ${expectation}, but the effect succeeded with:\n${show(exit.value)}`)
  }
  const cause = exit.cause
  if (cause.reasons.length !== 1) {
    throw new Error(
      `Expected ${expectation} as the only reason, but the cause has ${cause.reasons.length}:\n${Cause.pretty(cause)}`
    )
  }
  return { reason: cause.reasons[0]!, cause }
}

/**
 * The single typed failure of `exit`.
 *
 * Throws when the effect succeeded, died, was interrupted, or failed for more than one reason.
 *
 * @since 0.2.0
 * @category extractors
 */
export const failureOf = <A, E>(exit: Exit.Exit<A, E>): E => {
  const { cause, reason } = onlyReason(exit, "a typed failure")
  if (!Cause.isFailReason(reason)) {
    throw new Error(`Expected a typed failure but got a ${reason._tag}:\n${Cause.pretty(cause)}`)
  }
  return reason.error
}

/**
 * The single defect of `exit`.
 *
 * Throws when the effect succeeded, failed with a typed error, was interrupted, or died for more than one reason.
 *
 * @since 0.2.0
 * @category extractors
 */
export const defectOf = <A, E>(exit: Exit.Exit<A, E>): unknown => {
  const { cause, reason } = onlyReason(exit, "a defect")
  if (!Cause.isDieReason(reason)) {
    throw new Error(`Expected a defect but got a ${reason._tag}:\n${Cause.pretty(cause)}`)
  }
  return reason.defect
}

/**
 * Asserts that `exit` failed with exactly `expected` and nothing else.
 *
 * Equality is `Equal.equals`, so `Data.TaggedError` instances compare by their fields (including
 * `hint`), `Option`s by content, and `Redacted` values by the secret they wrap.
 *
 * @since 0.2.0
 * @category assertions
 */
export const assertFails = <A, E>(exit: Exit.Exit<A, E>, expected: E, message?: string): void => {
  Assert.assertEquals(failureOf(exit), expected, message)
}

/**
 * Asserts that `exit` succeeded with exactly `expected`, using `Equal.equals`.
 *
 * @since 0.2.0
 * @category assertions
 */
export const assertSucceeds = <A, E>(exit: Exit.Exit<A, E>, expected: A, message?: string): void => {
  if (Exit.isFailure(exit)) {
    throw new Error(`Expected success with ${show(expected)}, but the effect failed:\n${Cause.pretty(exit.cause)}`)
  }
  Assert.assertEquals(exit.value, expected, message)
}

/**
 * Asserts that none of `secrets` appears when `value` is rendered the way a log line, an error
 * message, or a thrown exception would render it (`node:util` `inspect` plus `String(value)`).
 *
 * @since 0.2.0
 * @category assertions
 */
export const assertRedacted = (value: unknown, secrets: ReadonlyArray<string>): void => {
  const renderings = [inspect(value, { depth: null }), String(value)]
  try {
    const json = JSON.stringify(value)
    if (json !== undefined) renderings.push(json)
  } catch {
    // Cyclic or BigInt values cannot be serialised; the other renderings still apply.
  }
  for (const secret of secrets) {
    Assert.assertTrue(secret !== "", "assertRedacted needs non-empty secrets to search for")
    for (const rendered of renderings) {
      Assert.assertFalse(
        rendered.includes(secret),
        `Secret ${JSON.stringify(secret)} leaked into the rendering:\n${rendered}`
      )
    }
  }
}
