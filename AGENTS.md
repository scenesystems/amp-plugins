# AGENTS.md

Reusable Amp plugins written in Effect 4, built with Bun, shipped as self-contained bundles. `README.md` has the
layout, commands, install flow, and dependency policy; this file is the mental model behind them.

## Shape

Three kinds of package, one direction of dependency:

- `packages/core` adapts the Amp Plugin API to Effect: a tool is a `Schema` input plus an Effect body, a plugin is a
  `Layer` turned into a `ManagedRuntime` that lives as long as the plugin. Everything a plugin needs from Amp comes
  through services, not globals.
- `plugins/<name>` is one integration each. Inside a plugin the layers are: credentials → auth → a service that speaks
  the remote API → tools that render results for an agent → an entry file that wires the layer. Each layer is a
  service with a typed error, so every fault has a name and a place to be handled.
- `packages/testing` holds fixtures shared across plugins (exact `Exit` assertions, a recording `HttpClient`, a fake
  `PluginAPI`). It is not a runner and has no tests of its own; every consumer exercises it.

Plugins run inside Amp's Bun process with no `node_modules`, so a plugin's runtime is exactly its bundle: inline what
you use, keep `@ampcode/plugin` type-only, and keep the entry file's `description` a static literal the build can find.
The agent reads tool output and errors, so those strings are the product: they are contracts, not logging.

## How we work

- Effect 4, not Effect 3. Import modules by path and read the installed `.d.ts` when an API name is uncertain;
  memory of v3 (and of earlier release candidates) is wrong often enough to be a liability. After a bump, fix the code
  forward, never pin back.
- Effects are explicit. Configuration is `Config`/`Redacted`, IO is a service (`HttpClient`, `FileSystem`, `Clock`),
  logging goes through Amp. Anything a plugin reaches for directly (`process.env`, `console`, `Bun.*`) is both a lint
  error and a sign the code cannot be tested at the seam it should be.
- `bun run ci` is the definition of done: types, lint, formatting, unit tests, build, and the bundle smoke test.
  Formatting and lint fixes are automated (`bun run lint:fix`); do not hand-format.
- Dependencies are deliberate. Ranges say what we accept, the lockfile says what we tested, and Renovate turns the gap
  into CI-checked PRs. Things that must move together (the Effect family, the tsgo toolchain) are grouped; things with
  odd publishing (`@ampcode/plugin`) are pinned. README "Dependency versions" records the reasoning per package.

## How we test

A test states a contract and fails whenever that contract changes. Three layers, each catching what the others cannot:

- Unit tests (`bun run test`, `@effect/vitest`) run plugin logic against a hand-written fake placed at a real seam,
  either the `HttpClient` when the wire protocol is under test or the plugin's own API service when the tool is. They
  assert whole values: the full rendered output, the full request sequence, the exact typed error via `Effect.exit`.
  Substring matches, guarded assertions that may not run, and `Effect.flip` (which hides defects and interruptions) are
  not proofs. Pure functions and schemas get property tests.
- Contract tests (`bun run test:contract`) run the same code against the real remote API with real credentials, so the
  fakes stay honest. They fail fast without credentials rather than skipping.
- The bundle smoke test (`bun run test:bundle`) loads what we actually ship under Bun. It is the one place a
  distribution check belongs, and it is labelled as such.

When a test is hard to write, the seam is in the wrong place; fix the code rather than the test. Never write tests
about the test fixtures themselves.

## Adding a plugin

Copy the shape of `plugins/google-workspace`: credential and auth services with typed errors, one API service that
owns HTTP and error mapping, tools built with `Tool.make`, a skill that teaches the agent when to use them, tests at
each seam, and a contract suite gated on that integration's credentials. Register the package in the root
`tsconfig.json` and add its credential secrets to the CI contract job.
