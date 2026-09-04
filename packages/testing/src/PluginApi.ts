/**
 * A fake Amp `PluginAPI` that records what a plugin registers, plus the matching fake
 * `PluginToolContext` / `PluginCommandContext`.
 *
 * Only the members the plugins in this repository use are implemented. Touching any other member
 * dies with `NotImplemented` immediately, so a plugin that starts depending on more of the API fails
 * its tests loudly instead of receiving `undefined`.
 *
 * Amp's API is Promise-shaped; the fake produces those promises by running effects, so this file is
 * the one place in the test support where effects are run. It depends on no test framework: the
 * same fake drives the vitest suites on Node and the bundle smoke test on Bun.
 */
import type {
  CommandAvailability,
  CommandSubscription,
  PluginAPI,
  PluginCommandContext,
  PluginCommandOptions,
  PluginSkillDefinition,
  PluginToolContext,
  PluginToolDefinition,
  PluginToolResult,
  Subscription,
  User
} from "@ampcode/plugin"
import * as Arr from "effect/Array"
import * as Effect from "effect/Effect"
import * as MutableRef from "effect/MutableRef"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import { inspect } from "node:util"

/**
 * A lookup for a tool or command the plugin never registered.
 *
 * @category errors
 */
export class UnknownRegistration extends Schema.TaggedError<UnknownRegistration>()("UnknownRegistration", {
  kind: Schema.Literals(["tool", "command"]),
  wanted: Schema.String,
  registered: Schema.Array(Schema.String)
}) {
  override get message(): string {
    return `No ${this.kind} named ${inspect(this.wanted)}; registered: ${this.registered.join(", ")}`
  }
}

/**
 * A tool result that was not plain text when the test asserted on rendered text.
 *
 * @category errors
 */
export class NotText extends Schema.TaggedError<NotText>()("NotText", {
  result: Schema.Unknown
}) {
  override get message(): string {
    return `Expected a text tool result, got:\n${inspect(this.result, { depth: 4 })}`
  }
}

/**
 * The plugin read a member of the host API that this fake does not implement.
 *
 * @category errors
 */
export class NotImplemented extends Schema.TaggedError<NotImplemented>()("NotImplemented", {
  object: Schema.String,
  property: Schema.String
}) {
  override get message(): string {
    return `${this.object}.${this.property} is not implemented by the fake PluginAPI`
  }
}

/**
 * A command as the plugin registered it.
 *
 * @category models
 */
export interface RegisteredCommand {
  readonly id: string
  readonly options: PluginCommandOptions
  readonly handler: (ctx: PluginCommandContext) => void | Promise<void>
  readonly availability: ReadonlyArray<CommandAvailability>
}

/**
 * Everything observable about a plugin's interaction with the fake API.
 *
 * @category models
 */
export interface Fake {
  readonly api: PluginAPI
  /** Tools in registration order. Removed again when their subscription is unsubscribed. */
  readonly tools: ReadonlyArray<PluginToolDefinition>
  /** Commands in registration order. */
  readonly commands: ReadonlyArray<RegisteredCommand>
  /** Skill directories the plugin contributed. */
  readonly skills: ReadonlyArray<PluginSkillDefinition>
  /** `amp.logger.log` calls, one array of arguments per call. */
  readonly logs: ReadonlyArray<ReadonlyArray<unknown>>
  /** `ui.notify` messages from command handlers run through `commandContext`. */
  readonly notifications: ReadonlyArray<string>
  /** Runs every `onDispose` callback in registration order, as Amp does when unloading the plugin. */
  readonly dispose: Effect.Effect<void>
  /** Number of `onDispose` callbacks registered. */
  readonly disposers: () => number
  /** The tool with `name`; fails with `UnknownRegistration` listing what is registered otherwise. */
  readonly tool: (name: string) => Effect.Effect<PluginToolDefinition, UnknownRegistration>
  /** The command with `id`; fails with `UnknownRegistration` listing what is registered otherwise. */
  readonly command: (id: string) => Effect.Effect<RegisteredCommand, UnknownRegistration>
  /** Runs the tool `name` with `input` through `toolContext`, exactly as Amp calls it. */
  readonly execute: (
    name: string,
    input: Record<string, unknown>
  ) => Effect.Effect<PluginToolResult | void, UnknownRegistration>
  /** A `PluginToolContext` whose logger records into `logs`. */
  readonly toolContext: PluginToolContext
  /** A `PluginCommandContext` whose `ui.notify` records into `notifications`. */
  readonly commandContext: PluginCommandContext
}

/**
 * @category models
 */
export interface Options {
  /** The signed-in Amp user, or `null` for an unauthenticated Amp. Default: `ari@example.test`. */
  readonly user?: User | null | undefined
}

/**
 * The text of a tool result. Fails with `NotText` when the tool returned content blocks or nothing,
 * so a test that asserts on rendered text cannot pass by accident when the result shape changes.
 *
 * @category accessors
 */
export const text = (result: PluginToolResult | void): Effect.Effect<string, NotText> =>
  Predicate.isString(result) ? Effect.succeed(result) : Effect.fail(new NotText({ result }))

/**
 * A `User` with only `email` set to something meaningful.
 *
 * @category constructors
 */
export const user = (email: string): User => ({
  id: `user-${email}`,
  email,
  firstName: null,
  lastName: null,
  username: null,
  workspace: null
})

/**
 * `implemented` as a `T`, where reading any member that was not implemented dies with
 * `NotImplemented`. A `Proxy` is the only way to stand in for a host interface this large without
 * restating it, and typing the proxy as the host interface is an assertion by nature. The trap is
 * synchronous host code, so the defect is raised by running it.
 */
// oxlint-disable-next-line effect-native/utility-types -- the implemented subset of a host interface we do not own
const strict = <T extends object>(name: string, implemented: Partial<T>): T =>
  // oxlint-disable-next-line effect-native/type-assertions, typescript/no-unsafe-type-assertion -- a Proxy can only be typed as its host interface by assertion
  new Proxy(implemented as T, {
    get(target, property) {
      return property in target
        ? Reflect.get(target, property)
        : Effect.runSync(Effect.die(new NotImplemented({ object: name, property: String(property) })))
    }
  })

/** Runs a host `onDispose` callback, which may return nothing or a promise. */
const runDisposer = (callback: () => void | Promise<void>): Effect.Effect<void> =>
  Effect.suspend(() => {
    const result = callback()
    return result === undefined ? Effect.void : Effect.promise(() => result)
  })

/**
 * Creates a fresh fake API. Each call is independent; nothing is shared across tests.
 *
 * @category constructors
 */
export const make = (options: Options = {}): Fake => {
  const tools = MutableRef.make<ReadonlyArray<PluginToolDefinition>>([])
  const commands = MutableRef.make<ReadonlyArray<RegisteredCommand>>([])
  const skills = MutableRef.make<ReadonlyArray<PluginSkillDefinition>>([])
  const logs = MutableRef.make<ReadonlyArray<ReadonlyArray<unknown>>>([])
  const notifications = MutableRef.make<ReadonlyArray<string>>([])
  const disposers = MutableRef.make<ReadonlyArray<() => void | Promise<void>>>([])

  /** Adds `item` to `ref`; the returned subscription removes it again. */
  const register = <A>(ref: MutableRef.MutableRef<ReadonlyArray<A>>, item: A): Subscription => {
    MutableRef.update(ref, Arr.append(item))
    return { unsubscribe: () => MutableRef.update(ref, Arr.filter((existing) => existing !== item)) }
  }

  const logger = { log: (...args: Array<unknown>) => MutableRef.update(logs, Arr.append(args)) }
  const system = strict<PluginAPI["system"]>("system", {
    user: options.user === undefined ? user("ari@example.test") : options.user
  })
  const ui = strict<PluginAPI["ui"]>("ui", {
    notify: (message: string) =>
      Effect.runPromise(Effect.sync(() => MutableRef.update(notifications, Arr.append(message))).pipe(Effect.asVoid))
  })

  const api = strict<PluginAPI>("api", {
    logger,
    system,
    ui,
    registerTool: (definition) => register(tools, definition),
    registerCommand: (id, options, handler) => {
      const availability = MutableRef.make<ReadonlyArray<CommandAvailability>>([])
      const registered: RegisteredCommand = {
        id,
        options,
        handler,
        get availability() {
          return MutableRef.get(availability)
        }
      }
      const subscription: CommandSubscription = {
        ...register(commands, registered),
        setAvailability: (status) => MutableRef.update(availability, Arr.append(status))
      }
      return subscription
    },
    registerSkill: (definition) => Effect.runPromise(Effect.sync(() => register(skills, definition))),
    onDispose: (callback) => register(disposers, callback)
  })

  const find = <T>(
    kind: "tool" | "command",
    items: ReadonlyArray<T>,
    key: (item: T) => string,
    wanted: string
  ): Effect.Effect<T, UnknownRegistration> =>
    Effect.fromOption(
      Arr.findFirst(items, (item) => key(item) === wanted),
      () => new UnknownRegistration({ kind, wanted, registered: items.map(key) })
    )
  const toolContext = strict<PluginToolContext>("toolContext", { logger, ui })
  const tool = (name: string) => Effect.suspend(() => find("tool", MutableRef.get(tools), (t) => t.name, name))

  return {
    api,
    get tools() {
      return MutableRef.get(tools)
    },
    get commands() {
      return MutableRef.get(commands)
    },
    get skills() {
      return MutableRef.get(skills)
    },
    get logs() {
      return MutableRef.get(logs)
    },
    get notifications() {
      return MutableRef.get(notifications)
    },
    disposers: () => MutableRef.get(disposers).length,
    dispose: Effect.suspend(() => Effect.forEach(MutableRef.get(disposers), runDisposer, { discard: true })),
    tool,
    command: (id) => Effect.suspend(() => find("command", MutableRef.get(commands), (c) => c.id, id)),
    execute: (name, input) =>
      Effect.flatMap(tool(name), (definition) => Effect.promise(() => definition.execute(input, toolContext))),
    toolContext,
    commandContext: strict<PluginCommandContext>("commandContext", { ui, system })
  }
}
