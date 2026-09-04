/**
 * Builds the plugin's `ManagedRuntime` from a `Layer`, with the `Amp` service
 * provided and disposal tied to Amp unloading the plugin.
 */
import type { PluginAPI } from "@ampcode/plugin"
import * as Layer from "effect/Layer"
import * as ManagedRuntime from "effect/ManagedRuntime"
import * as Amp from "./Amp.ts"

/**
 * Creates a runtime for `layer`, which may depend on `Amp`. Layer construction
 * errors are turned into defects and surface, rendered by `Tool.toPluginTool`,
 * when the first tool runs, so a misconfigured plugin still loads and reports a
 * readable failure instead of crashing Amp.
 *
 * @category constructors
 */
export const make = <R, E>(
  api: PluginAPI,
  layer: Layer.Layer<R, E, Amp.Amp>
): ManagedRuntime.ManagedRuntime<R | Amp.Amp, never> => {
  const runtime = ManagedRuntime.make(
    Layer.provideMerge(Layer.orDie(layer), Amp.layer(api))
  )
  api.onDispose(() => runtime.dispose())
  return runtime
}
