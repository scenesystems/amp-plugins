/**
 * `effect-native`: the syntactic half of our Effect discipline, as an oxlint JS plugin.
 *
 * `effecttsgo/*` (type-aware, from `@effect/tsgo`) catches misuse of Effect itself. This plugin catches the plain
 * JavaScript and TypeScript that should have been Effect in the first place: casts instead of schemas, loops and
 * `let` instead of `Arr`/`Effect.forEach`, `switch` instead of `Match`, `throw` instead of typed errors, `Map`
 * instead of `HashMap`, and so on. Each rule is a small set of ESLint selectors with one message per selector; the
 * message names the pattern and the Effect replacement.
 *
 * The rule set mirrors the `effect/*` registry in scenesystems/eva so a violation means the same thing in every
 * Scene Systems repository. Selectors that `effecttsgo` already reports everywhere (async functions, `new Promise`,
 * `Date`, `Math.random`, `console`) are left out rather than reported twice.
 *
 * Applicability is decided in `.oxlintrc.json`: everything runs on `src/`; tests drop `no-throw-try`, `entry-point`,
 * and `no-log-interpolation` because a test is an entry point that may throw to fail.
 */
import { definePlugin, defineRule, type ESTree, type Rule, type Scope } from "@oxlint/plugins"

interface Restriction {
  readonly selector: string
  readonly message: string
}

/** A rule made of selectors: every match is reported with the selector's message. */
const restricted = (description: string, restrictions: ReadonlyArray<Restriction>): Rule =>
  defineRule({
    meta: { type: "problem", docs: { description }, schema: [] },
    createOnce: (context) => {
      const visitor: Record<string, (node: ESTree.Node) => void> = {}
      restrictions.forEach(({ selector, message }) => {
        visitor[selector] = (node) => context.report({ message, node })
      })
      return visitor
    }
  })

const promiseStatic = (name: string): string =>
  `CallExpression[callee.object.name='Promise'][callee.property.name='${name}']`
const objectStatic = (name: string): string =>
  `CallExpression[callee.object.name='Object'][callee.property.name='${name}']`
const effectRun = (name: string): string =>
  `CallExpression[callee.object.name='Effect'][callee.property.name='${name}']`
const utilityType = (name: string): string => `TSTypeReference[typeName.name='${name}']`
const succeedIn = (combinator: string, value: string): string =>
  `CallExpression[callee.property.name='${combinator}'] ArrowFunctionExpression CallExpression[callee.object.name='Effect'][callee.property.name='succeed'] ${value}`

const typeAssertions = restricted("Ban type assertions; validate at runtime with Schema instead", [
  {
    selector: "TSAsExpression",
    message: "Do not use 'as' (including 'as const'). Decode with Schema.decodeUnknown, or annotate the binding."
  },
  { selector: "TSTypeAssertion", message: "Do not use '<T>x' assertions. Decode with Schema.decodeUnknown." },
  {
    selector: "TSSatisfiesExpression",
    message: "Do not use 'satisfies'. Annotate the binding, or validate with Schema.is / Schema.decodeUnknown."
  },
  {
    selector: "TSNonNullExpression",
    message: "Do not use '!' non-null assertions. Model absence with Option and pattern-match."
  }
])

const noLet = restricted("Ban let; bindings are const and state lives in Ref", [
  { selector: "VariableDeclaration[kind='let']", message: "Do not use 'let'. Use 'const'; for mutable state use Ref." }
])

const imperativeLoops = restricted("Ban loops; use Arr, Record, Effect.forEach, Effect.iterate", [
  { selector: "ForStatement", message: "Do not use 'for'. Use Arr.map/filter/reduce, Arr.makeBy, or Effect.forEach." },
  { selector: "ForInStatement", message: "Do not use 'for...in'. Use Record.toEntries or Record.keys." },
  { selector: "ForOfStatement", message: "Do not use 'for...of'. Use Arr.map/forEach or Effect.forEach." },
  { selector: "WhileStatement", message: "Do not use 'while'. Use Effect.iterate, Effect.loop, or Arr.unfold." },
  { selector: "DoWhileStatement", message: "Do not use 'do...while'. Use Effect.iterate or Effect.loop." }
])

const switchStatement = restricted("Ban switch; use Match", [
  {
    selector: "SwitchStatement",
    message: "Do not use 'switch'. Use Match.valueTags / Match.type(...).pipe(Match.tag, Match.exhaustive)."
  }
])

const collections = restricted("Ban mutable built-in collections; use HashMap/HashSet", [
  { selector: "NewExpression[callee.name='Map']", message: "Do not use 'new Map()'. Use HashMap or MutableHashMap." },
  { selector: "NewExpression[callee.name='Set']", message: "Do not use 'new Set()'. Use HashSet or MutableHashSet." },
  { selector: "NewExpression[callee.name='WeakMap']", message: "Do not use 'new WeakMap()'. Use HashMap." },
  { selector: "NewExpression[callee.name='WeakSet']", message: "Do not use 'new WeakSet()'. Use HashSet." }
])

const objectBuiltins = restricted("Ban Object.* iteration; use Record", [
  { selector: objectStatic("entries"), message: "Do not use 'Object.entries()'. Use Record.toEntries." },
  { selector: objectStatic("keys"), message: "Do not use 'Object.keys()'. Use Record.keys." },
  { selector: objectStatic("values"), message: "Do not use 'Object.values()'. Use Record.values." },
  { selector: objectStatic("fromEntries"), message: "Do not use 'Object.fromEntries()'. Use Record.fromEntries." },
  { selector: objectStatic("assign"), message: "Do not use 'Object.assign()'. Use object spread or Record.union." },
  { selector: objectStatic("create"), message: "Do not use 'Object.create()'. Use an object literal or Schema.Class." }
])

const arrayBuiltins = restricted("Ban Array mutation and static helpers; use Arr", [
  {
    selector: "CallExpression[callee.property.name='push']",
    message: "Do not use '.push()'. Use Arr.append/appendAll."
  },
  { selector: "CallExpression[callee.property.name='unshift']", message: "Do not use '.unshift()'. Use Arr.prepend." },
  {
    selector: "CallExpression[callee.property.name='splice']",
    message: "Do not use '.splice()'. Use Arr.remove/insertAt."
  },
  {
    selector: "CallExpression[callee.object.name='Array'][callee.property.name='from']",
    message: "Do not use 'Array.from()'. Use Arr.fromIterable."
  },
  {
    selector: "CallExpression[callee.object.name='Array'][callee.property.name='isArray']",
    message: "Do not use 'Array.isArray()'. Use Arr.isArray or Predicate.isArray."
  }
])

const jsonBuiltins = restricted("Ban JSON.parse/stringify; use Schema codecs", [
  {
    selector: "CallExpression[callee.object.name='JSON'][callee.property.name='parse']",
    message: "Do not use 'JSON.parse()'. Use Schema.decodeUnknown(Schema.fromJsonString(...))."
  },
  {
    selector: "CallExpression[callee.object.name='JSON'][callee.property.name='stringify']",
    message: "Do not use 'JSON.stringify()'. Use Schema.encode(Schema.fromJsonString(...))."
  }
])

const noThrowTry = restricted("Ban throw and try/catch; failures are typed values", [
  {
    selector: "ThrowStatement",
    message: "Do not use 'throw'. Fail with a Schema.TaggedError (yield* new MyError(...)); for defects use Effect.die."
  },
  {
    selector: "TryStatement",
    message: "Do not use try/catch. Use Effect.try / Effect.tryPromise with a typed catch, or Effect.catchTag."
  }
])

const noNewError = restricted("Ban untyped Error construction", [
  { selector: "NewExpression[callee.name='Error']", message: "Do not use 'new Error()'. Define a Schema.TaggedError." },
  {
    selector: "NewExpression[callee.name='TypeError']",
    message: "Do not use 'new TypeError()'. Define a Schema.TaggedError."
  },
  {
    selector: "NewExpression[callee.name='RangeError']",
    message: "Do not use 'new RangeError()'. Define a Schema.TaggedError."
  }
])

const noAsync = restricted("Ban await and Promise combinators; stay in Effect", [
  { selector: "AwaitExpression", message: "Do not use 'await'. Use Effect.gen with yield*." },
  { selector: promiseStatic("resolve"), message: "Do not use 'Promise.resolve()'. Use Effect.succeed." },
  { selector: promiseStatic("reject"), message: "Do not use 'Promise.reject()'. Use Effect.fail with a typed error." },
  { selector: promiseStatic("all"), message: "Do not use 'Promise.all()'. Use Effect.all." },
  {
    selector: promiseStatic("allSettled"),
    message: "Do not use 'Promise.allSettled()'. Use Effect.forEach with Effect.exit."
  },
  { selector: promiseStatic("race"), message: "Do not use 'Promise.race()'. Use Effect.race / Effect.raceAll." },
  { selector: promiseStatic("any"), message: "Do not use 'Promise.any()'. Use Effect.raceAll." }
])

const promiseChaining = restricted("Ban .then/.catch/.finally; use Effect combinators", [
  {
    selector: "CallExpression[callee.property.name='then']",
    message: "Do not use '.then()'. Use Effect.map / Effect.flatMap."
  },
  {
    selector: "CallExpression[callee.property.name='catch'][callee.object.type!='Identifier']",
    message: "Do not use '.catch()'. Use Effect.catchTag / Effect.catch."
  },
  {
    selector: "CallExpression[callee.property.name='finally']",
    message: "Do not use '.finally()'. Use Effect.ensuring."
  }
])

const utilityTypes = restricted("Ban structural utility types; derive types from Schema", [
  {
    selector: utilityType("ReturnType"),
    message: "Do not use 'ReturnType<>'. Name the type, or derive it from a Schema."
  },
  {
    selector: utilityType("InstanceType"),
    message: "Do not use 'InstanceType<>'. Name the type, or derive it from a Schema."
  },
  { selector: utilityType("Awaited"), message: "Do not use 'Awaited<>'. Use Effect types." },
  { selector: utilityType("Parameters"), message: "Do not use 'Parameters<>'. Name the parameter type." },
  { selector: utilityType("Partial"), message: "Do not use 'Partial<>'. Use Schema.Struct with optional fields." },
  { selector: utilityType("Pick"), message: "Do not use 'Pick<>'. Use Schema.Struct.pick." },
  { selector: utilityType("Omit"), message: "Do not use 'Omit<>'. Use Schema.Struct.omit." },
  { selector: utilityType("Required"), message: "Do not use 'Required<>'. Define the required Schema.Struct." }
])

const tacitUsage = restricted("Ban flow(); write the arrow", [
  { selector: "CallExpression[callee.name='flow']", message: "Do not use flow(). Write (x) => g(f(x))." },
  {
    selector: "ImportDeclaration[source.value=/^effect/] ImportSpecifier[imported.name='flow']",
    message: "Do not import 'flow'. Write (x) => g(f(x))."
  }
])

const entryPoint = restricted("Ban Effect.run* outside the entry file", [
  {
    selector: effectRun("runPromise"),
    message: "Do not use 'Effect.runPromise' in library code. Run through the plugin's ManagedRuntime."
  },
  {
    selector: effectRun("runPromiseExit"),
    message: "Do not use 'Effect.runPromiseExit' in library code. Run through the plugin's ManagedRuntime."
  },
  {
    selector: effectRun("runSync"),
    message: "Do not use 'Effect.runSync' in library code. Run through the plugin's ManagedRuntime."
  },
  {
    selector: effectRun("runSyncExit"),
    message: "Do not use 'Effect.runSyncExit' in library code. Run through the plugin's ManagedRuntime."
  },
  {
    selector: effectRun("runFork"),
    message: "Do not use 'Effect.runFork' in library code. Run through the plugin's ManagedRuntime."
  }
])

const errorSwallowing = restricted("Ban catch handlers that replace an error with nothing", [
  {
    selector: succeedIn("catchAll", "Literal[value=null]"),
    message:
      "Do not swallow errors with catchAll(() => Effect.succeed(null)). Return Option.none() or handle the error."
  },
  {
    selector: succeedIn("catchAll", "Identifier[name='undefined']"),
    message:
      "Do not swallow errors with catchAll(() => Effect.succeed(undefined)). Return Option.none() or handle the error."
  },
  {
    selector: succeedIn("catchAll", "ArrayExpression[elements.length=0]"),
    message: "Do not swallow errors with catchAll(() => Effect.succeed([])). Handle the error."
  },
  {
    selector: succeedIn("catchTag", "Literal[value=null]"),
    message:
      "Do not swallow errors with catchTag(() => Effect.succeed(null)). Return Option.none() or handle the error."
  },
  {
    selector: succeedIn("catchTag", "Identifier[name='undefined']"),
    message:
      "Do not swallow errors with catchTag(() => Effect.succeed(undefined)). Return Option.none() or handle the error."
  },
  {
    selector: "Property[key.name='catch'] > ArrowFunctionExpression[body.type='Literal'][body.value=null]",
    message: "Do not use catch: () => null. Return a typed error: catch: (cause) => new MyError({ cause })."
  },
  {
    selector: "Property[key.name='catch'] > ArrowFunctionExpression[body.type='Identifier'][body.name='undefined']",
    message: "Do not use catch: () => undefined. Return a typed error: catch: (cause) => new MyError({ cause })."
  },
  {
    selector:
      "Property[key.name='catch'] > ArrowFunctionExpression[body.type='Identifier'][body.name=/^(e|err|error|cause)$/]",
    message: "Do not use catch: (e) => e. Wrap it: catch: (cause) => new MyError({ cause })."
  }
])

const noLogInterpolation = restricted(
  "Ban interpolated log messages; annotate structured fields",
  ["log", "logTrace", "logDebug", "logInfo", "logWarning", "logError", "logFatal"].map((method) => ({
    selector: `CallExpression[callee.object.name='Effect'][callee.property.name='${method}'] > TemplateLiteral`,
    message: `Do not interpolate into Effect.${method}(). Log a constant message and Effect.annotateLogs the values.`
  }))
)

const abortController = restricted("Ban AbortController; interruption is an Effect concern", [
  {
    selector: "NewExpression[callee.name='AbortController']",
    message: "Do not use 'new AbortController()'. Use Effect.interrupt / Fiber.interrupt."
  }
])

/**
 * `Error`, `TypeError`, `RangeError` as type annotations, when they resolve to the JavaScript globals. A file that
 * declares its own type with that name, or a type parameter of that name, is not reported.
 */
const globalErrorNames: ReadonlyArray<string> = ["Error", "TypeError", "RangeError"]

const declaresTypeNamed = (program: ESTree.Program, name: string): boolean =>
  program.body.some((statement) => {
    const declaration = statement.type === "ExportNamedDeclaration" ? statement.declaration : statement
    return declaration !== null
      && (declaration.type === "TSTypeAliasDeclaration" || declaration.type === "TSInterfaceDeclaration")
      && declaration.id.name === name
  })

const isGlobalBinding = (scope: Scope, name: string): boolean => {
  const binding = scope.variables.find((variable) => variable.name === name)
  if (binding !== undefined) return scope.type === "global" && binding.defs.length === 0
  return scope.upper === null || isGlobalBinding(scope.upper, name)
}

const errorTypeAnnotation: Rule = defineRule({
  meta: {
    type: "problem",
    docs: { description: "Ban the global Error types in annotations; use typed errors" },
    schema: []
  },
  create: (context) => ({
    TSTypeReference: (node) => {
      if (node.typeName.type !== "Identifier") return
      const name = node.typeName.name
      if (!globalErrorNames.includes(name)) return
      if (declaresTypeNamed(context.sourceCode.ast, name)) return
      if (!isGlobalBinding(context.sourceCode.getScope(node), name)) return
      context.report({
        message:
          `Do not use the global '${name}' as a type. Use a Schema.TaggedError (or Cause.UnknownError for foreign errors).`,
        node: node.typeName
      })
    }
  })
})

export default definePlugin({
  meta: { name: "effect-native" },
  rules: {
    "type-assertions": typeAssertions,
    "no-let": noLet,
    "imperative-loops": imperativeLoops,
    "switch-statement": switchStatement,
    "collections": collections,
    "object-builtins": objectBuiltins,
    "array-builtins": arrayBuiltins,
    "json-builtins": jsonBuiltins,
    "no-throw-try": noThrowTry,
    "no-new-error": noNewError,
    "no-async": noAsync,
    "promise-chaining": promiseChaining,
    "utility-types": utilityTypes,
    "tacit-usage": tacitUsage,
    "entry-point": entryPoint,
    "error-swallowing": errorSwallowing,
    "no-log-interpolation": noLogInterpolation,
    "abort-controller": abortController,
    "error-type-annotation": errorTypeAnnotation
  }
})
