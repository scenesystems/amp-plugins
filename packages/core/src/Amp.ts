/**
 * The Amp `PluginAPI` as an Effect service, so plugin code can reach the logger,
 * system info, UI, and thread APIs through the Effect context instead of a closure.
 *
 * @since 0.1.0
 */
import type { PluginAPI } from "@ampcode/plugin"
import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

/**
 * Service key for the `PluginAPI` instance handed to the plugin's default export.
 *
 * ```ts
 * const program = Effect.gen(function*() {
 *   const amp = yield* Amp
 *   amp.logger.log("hello from", amp.system.user?.email)
 * })
 * ```
 *
 * @since 0.1.0
 * @category services
 */
export class Amp extends Context.Service<Amp, PluginAPI>()("@scenesystems/amp-plugin-core/Amp") {}

/**
 * Provides the `Amp` service from a concrete `PluginAPI`.
 *
 * @since 0.1.0
 * @category layers
 */
export const layer = (api: PluginAPI): Layer.Layer<Amp> => Layer.succeed(Amp)(api)

/**
 * Logs through Amp's plugin-scoped logger (visible in Amp's plugin output),
 * independent of Effect's own logger configuration.
 *
 * @since 0.1.0
 * @category logging
 */
export const log = (...args: ReadonlyArray<unknown>): Effect.Effect<void, never, Amp> =>
  Amp.useSync((amp) => amp.logger.log(...args))
