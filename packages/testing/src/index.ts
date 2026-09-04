/**
 * Shared test fixtures for the plugins in this repository. The test runner is `@effect/vitest`;
 * these modules only add what it does not ship: exact exit assertions, a recording `HttpClient`,
 * and a fake Amp `PluginAPI`.
 *
 * @since 0.2.0
 */

/**
 * Exact assertions about how an Effect ended.
 *
 * @since 0.2.0
 */
export * as Assert from "./Assert.ts"

/**
 * Recording `HttpClient` stub and request/response readers.
 *
 * @since 0.2.0
 */
export * as Http from "./Http.ts"

/**
 * Fake Amp `PluginAPI` that records registrations.
 *
 * @since 0.2.0
 */
export * as PluginApi from "./PluginApi.ts"
