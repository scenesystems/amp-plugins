# AGENTS.md

Bun workspace of Amp plugins written in Effect 4. Read `README.md` for layout and install instructions.

## Commands

- `bun install` — installs and runs `effect-tsgo patch` (required; never skip the `prepare` script).
- `bun run check` — `tsc -b tsconfig.json` (TypeScript 7 / tsgo). Add new packages to the root `tsconfig.json` references.
- `bun run lint` / `bun run lint:fix` — oxlint (type-aware, Effect rules) then dprint.
- `bun test` — Bun's test runner. Tests live in `test/*.test.ts` next to `src/`. Write Effect tests with
  `it.effect`/`it.live`/`it.layer`/`it.prop` from `@scenesystems/amp-plugin-testing` (`packages/testing`), not with
  hand-rolled `Effect.runPromise`; use plain `test` only for Promise-returning boundaries such as `PluginToolDefinition.execute`.
- `bun run build [name]` — bundles `plugins/*` to `dist/<name>/`. Run after changing a plugin entry point.
- `bun run ci` — everything above, in order. Run before committing.

## Conventions

- Effect 4 (`effect@4.0.0-rc.x`). Import modules by path (`import * as Effect from "effect/Effect"`), never the barrel.
  The API differs from Effect 3: `Context.Service` (not `Context.Tag`/`Effect.Service`), `Layer.effect(Key)(effect)`,
  `Effect.catchCause`, `Schema.decodeUnknownEffect`, `Schema.toJsonSchemaDocument`. Check `node_modules/effect/dist/*.d.ts`
  when unsure; do not rely on Effect 3 memory.
- Tools are `Tool.make({...})` from `@scenesystems/amp-plugin-core` with a `Schema.Struct` input and an Effect body.
  Use `Schema.Finite` (not `Schema.Number`) for numeric tool inputs so the JSON Schema stays a plain `number`.
  Fail with `ToolError` (message + hint) for anything the agent should read and act on.
- Plugin entry files must keep `export const description = "…"` as a static string literal ≤ 300 characters; the build
  script rewrites the bundle to preserve it and fails if it cannot.
- Plugins run inside Amp's Bun process with no `node_modules`: everything must be bundled, so do not add runtime
  dependencies that cannot be inlined by `bun build`. `@ampcode/plugin` is types-only; use `import type`.
- Read configuration via `Config`/`Redacted` in Effect code; `process.env` is a lint error outside `scripts/` and tests.
  Log via `Amp.log` or `Effect.log`; `console` is a lint error in plugin code.
- Formatting is dprint (Effect style: no semicolons, double quotes, no trailing commas, 120 columns). Run
  `bun run format` instead of hand-formatting.
- Dependency versions follow README "Dependency versions": `effect`, `@types/bun`, `dprint` use `^` ranges;
  `@ampcode/plugin` and the toolchain (`typescript`, `oxlint`, `oxlint-tsgolint`, `@effect/tsgo`) are exact. Bump the
  toolchain together to versions on `@effect/tsgo`'s support table (`bun install` fails otherwise). Never write
  `@ampcode/plugin` as a range: it resolves to the stale `0.0.0-dev`. Renovate (`renovate.json`) opens upgrade PRs.
- Effect 4 renames between release candidates (e.g. `Effect.fork` → `Effect.forkChild`, `ServiceMap` → `Context`).
  After an `effect` bump, fix `bun run check` errors by reading the new `.d.ts`, not by pinning back.
- Never commit `dist/`, credentials, or `.env` files. Google credentials come from Amp secrets as environment variables.
