/**
 * A fake Amp `PluginAPI` that records what a plugin registers, plus the matching fake
 * `PluginToolContext` / `PluginCommandContext`.
 *
 * Only the members the plugins in this repository use are implemented. Touching any other member
 * throws immediately, so a plugin that starts depending on more of the API fails its tests loudly
 * instead of receiving `undefined`.
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
import { inspect } from "node:util"

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
  readonly dispose: () => Promise<void>
  /** Number of `onDispose` callbacks registered. */
  readonly disposers: () => number
  /** The tool with `name`, or throws listing what is registered. */
  readonly tool: (name: string) => PluginToolDefinition
  /** The command with `id`, or throws listing what is registered. */
  readonly command: (id: string) => RegisteredCommand
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
 * The text of a tool result. Throws when the tool returned content blocks or nothing, so a test
 * that asserts on rendered text cannot pass by accident when the result shape changes.
 *
 * @category accessors
 */
export const text = (result: PluginToolResult | void): string => {
  if (typeof result === "string") return result
  throw new Error(`Expected a text tool result, got:\n${inspect(result, { depth: 4 })}`)
}

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

const strict = <T extends object>(name: string, implemented: Partial<T>): T =>
  new Proxy(implemented as T, {
    get(target, property) {
      if (property in target) return target[property as keyof T]
      throw new Error(`${name}.${String(property)} is not implemented by the fake PluginAPI`)
    }
  })

/**
 * Creates a fresh fake API. Each call is independent; nothing is shared across tests.
 *
 * @category constructors
 */
export const make = (options: Options = {}): Fake => {
  const tools: Array<PluginToolDefinition> = []
  const commands: Array<RegisteredCommand> = []
  const skills: Array<PluginSkillDefinition> = []
  const logs: Array<ReadonlyArray<unknown>> = []
  const notifications: Array<string> = []
  const disposers: Array<() => void | Promise<void>> = []

  const logger = { log: (...args: Array<unknown>) => void logs.push(args) }
  const system = strict<PluginAPI["system"]>("system", {
    user: options.user === undefined ? user("ari@example.test") : options.user
  })
  const ui = strict<PluginAPI["ui"]>("ui", {
    notify: (message: string) => {
      notifications.push(message)
      return Promise.resolve()
    }
  })

  const api = strict<PluginAPI>("api", {
    logger,
    system,
    ui,
    registerTool: (definition) => {
      tools.push(definition)
      return {
        unsubscribe: () => {
          const index = tools.indexOf(definition)
          if (index >= 0) tools.splice(index, 1)
        }
      } satisfies Subscription
    },
    registerCommand: (id, options, handler) => {
      const availability: Array<CommandAvailability> = []
      const registered: RegisteredCommand = { id, options, handler, availability }
      commands.push(registered)
      return {
        unsubscribe: () => {
          const index = commands.indexOf(registered)
          if (index >= 0) commands.splice(index, 1)
        },
        setAvailability: (status) => void availability.push(status)
      } satisfies CommandSubscription
    },
    registerSkill: (definition) => {
      skills.push(definition)
      return Promise.resolve(
        {
          unsubscribe: () => {
            const index = skills.indexOf(definition)
            if (index >= 0) skills.splice(index, 1)
          }
        } satisfies Subscription
      )
    },
    onDispose: (callback) => {
      disposers.push(callback)
      return {
        unsubscribe: () => {
          const index = disposers.indexOf(callback)
          if (index >= 0) disposers.splice(index, 1)
        }
      } satisfies Subscription
    }
  })

  const find = <T>(kind: string, items: ReadonlyArray<T>, key: (item: T) => string, wanted: string): T => {
    const found = items.find((item) => key(item) === wanted)
    if (found === undefined) {
      throw new Error(`No ${kind} named ${JSON.stringify(wanted)}; registered: ${items.map(key).join(", ")}`)
    }
    return found
  }

  return {
    api,
    tools,
    commands,
    skills,
    logs,
    notifications,
    disposers: () => disposers.length,
    dispose: async () => {
      for (const callback of disposers) await callback()
    },
    tool: (name) => find("tool", tools, (t) => t.name, name),
    command: (id) => find("command", commands, (c) => c.id, id),
    toolContext: strict<PluginToolContext>("toolContext", { logger, ui }),
    commandContext: strict<PluginCommandContext>("commandContext", { ui, system })
  }
}
