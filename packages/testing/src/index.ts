/**
 * Shared test fixtures for the plugins in this repository. The test runner is `@effect/vitest`;
 * these modules only add what it does not ship: exact exit assertions, a recording `HttpClient`,
 * and a fake Amp `PluginAPI`.
 */

/**
 * Exact assertions about how an Effect ended.
 */
export * as Assert from "./Assert.ts"

/**
 * Recording `HttpClient` stub and request/response readers.
 */
export * as Http from "./Http.ts"

/**
 * Fake Amp `PluginAPI` that records registrations.
 */
export * as PluginApi from "./PluginApi.ts"
