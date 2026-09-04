# amp-plugins

Reusable [Amp](https://ampcode.com) plugins, written in [Effect](https://effect.website) 4 and built with
[Bun](https://bun.sh). Each plugin bundles to a single directory you can install in Amp directly or copy into your own
User or Workspace plugin repository.

| Plugin                                       | Status | What it adds                                                                  |
| -------------------------------------------- | ------ | ----------------------------------------------------------------------------- |
| [google-workspace](plugins/google-workspace) | ready  | Google Drive search, Docs as Markdown, Sheets ranges, comments; bundled skill |

## Install a plugin

Amp does not load plugins from GitHub or npm. It loads them from your **Workspace Plugins** repository (everyone in the
Amp workspace), your **Personal Plugins** repository (just you), a project's `.amp/plugins/`, or `~/.config/amp/plugins/`
on one machine. This repository is where plugins are built; a [GitHub Release](../../releases/latest) holds the
ready-to-install output, one `<plugin>.zip` per plugin. Bundles are self-contained (Effect and shared code inlined), so
Amp needs no `bun install` to run them.

### Let Amp do it

Install the bundled skill once, then ask Amp in any thread:

```sh
amp skill add --global scenesystems/amp-plugins   # installs every skill under .agents/skills/
```

> Install the google-workspace plugin from scenesystems/amp-plugins into our workspace plugins.

The skill downloads the release, copies it into the right plugin repository clone, commits, and asks before pushing.

### By hand

```sh
# 1. Get the built plugin (stable "latest" URL; or `bun run build` in a clone of this repo)
curl -fsSL -o google-workspace.zip \
  https://github.com/scenesystems/amp-plugins/releases/latest/download/google-workspace.zip

# 2. Put it where Amp loads plugins from
amp plugins repositories                 # prints your Personal and Workspace repositories and clone commands
amp clone workspace-plugins ~/.cache/amp/repositories/ampcode.com-workspace-plugins   # or user-plugins
unzip -o google-workspace.zip -d ~/.cache/amp/repositories/ampcode.com-workspace-plugins

# 3. Publish: commit and push in that clone (workspace pushes need workspace admin permission)
git -C ~/.cache/amp/repositories/ampcode.com-workspace-plugins add google-workspace
git -C ~/.cache/amp/repositories/ampcode.com-workspace-plugins commit -m "Add google-workspace plugin"
git -C ~/.cache/amp/repositories/ampcode.com-workspace-plugins push
```

For one project or one machine instead, unzip into `.amp/plugins/` or `~/.config/amp/plugins/` and run
`plugins: reload` from Amp's command palette. Each plugin's README lists the secrets it reads (for example
`GOOGLE_SERVICE_ACCOUNT_KEY`); set them as Amp workspace or personal secrets so they reach the plugin as environment
variables.

### Releasing (maintainers)

Tag `main` with `vX.Y.Z` and push the tag. `.github/workflows/release.yml` runs `bun run ci`, zips every
`dist/<plugin>/`, and attaches the zips plus `SHA256SUMS` to a GitHub Release with generated notes.

## Develop

Requires Bun ≥ 1.3 and Node 24 (`.node-version`; Vitest runs the unit tests on Node).

```sh
bun install          # also patches tsc/oxlint with the Effect language service (@effect/tsgo)
bun run check        # TypeScript 7 (tsgo), all workspace projects
bun run lint         # oxlint (type-aware Effect rules) + dprint
bun run test         # unit tests (Vitest + @effect/vitest); `bun run test:watch` to iterate
bun run build        # dist/<plugin>/ for every plugin, or `bun run build google-workspace`
bun run test:bundle  # build, then load dist/*/index.js under Bun, the runtime Amp uses
bun run ci           # all of the above, in order
bun run test:contract  # real Google APIs; needs GOOGLE_SERVICE_ACCOUNT_KEY + GOOGLE_WORKSPACE_CONTRACT_FOLDER
```

To try a build inside Amp without installing it, copy `dist/<plugin>/` into `~/.config/amp/plugins/<plugin>/` and run
`plugins: reload` from the command palette.

### Layout

```
packages/core/            @scenesystems/amp-plugin-core — Effect ↔ Amp Plugin API adapters
packages/testing/         @scenesystems/amp-plugin-testing — exact exit assertions, HttpClient stub, fake PluginAPI
plugins/<name>/           one directory plugin per package
  src/index.ts            plugin entry: `export const description` + default export
  skills/<skill>/SKILL.md bundled Agent Skills (optional)
  test/*.test.ts          unit tests (Vitest); test/support/ fixtures; test/contract/ real-API tests
scripts/build.ts          bundles plugins/* → dist/*
scripts/bundle.test.ts    bun:test smoke test of the built bundles
```

`packages/core` gives you `Tool.make` (Schema-typed tool input, Effect body, errors rendered for the agent),
`Runtime.make` (a `ManagedRuntime` from your `Layer`, disposed with the plugin), and the `Amp` service exposing the
`PluginAPI` inside Effect code.

### Testing

Three layers, each catching a class of regression the others cannot:

| Command                 | Runner                                                                                                     | Proves                                                                                                                                                     |
| ----------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run test`          | Vitest on Node with [`@effect/vitest`](https://github.com/Effect-TS/effect-smol/tree/main/packages/vitest) | Plugin logic against hand-written fakes at the `HttpClient` or `Google` service seam: exact tool output, exact request sequence, exact typed failure.      |
| `bun run test:contract` | Same, `plugins/*/test/contract/`                                                                           | The fakes' assumptions about Google. Creates and deletes fixtures in a real Drive folder. Fails fast when credentials are missing; never silently skipped. |
| `bun run test:bundle`   | `bun test` on `dist/*/index.js`                                                                            | The artifact Amp loads: single `description` literal, only Node builtins imported, activation registers every tool, credential errors render under Bun.    |

Unit tests use `it.effect`/`it.live`/`it.layer`/`it.prop` from `@effect/vitest`, assertions from
`@effect/vitest/utils` (`Assert.deepStrictEqual`, `Assert.assertEquals`, …), and `effect/testing` (`TestClock`,
`FastCheck`, `TestSchema.Asserts`). `@scenesystems/amp-plugin-testing` adds only what those do not ship: exact
`Exit` assertions (`ExitAssert.assertFails` proves one typed failure and no defect or interruption), a recording
`HttpClient` stub, and a fake Amp `PluginAPI` that lets a test call `amp.tool("gdocs_read").execute(input, ctx)` exactly
the way Amp does.

```ts
import * as Assert from "@effect/vitest/utils"
import { it } from "@effect/vitest"
import { Assert as ExitAssert, Http } from "@scenesystems/amp-plugin-testing"

it.effect("401 refreshes the token once", () =>
  Effect.gen(function*() {
    const exit = yield* Effect.exit(Google.getFile("abc"))
    ExitAssert.assertFails(exit, new GoogleApiError({ message: "Invalid Credentials", status: 401, reason: "authError" }))
    Assert.deepStrictEqual(http.requests.map(Http.endpoint), ["GET https://www.googleapis.com/drive/v3/files/abc", ...])
  }).pipe(Effect.provide(Layer)))
```

Effect's default `ConfigProvider` snapshots `process.env` on first read and memoises it for the process, so tests
provide configuration with `ConfigProvider.layer(ConfigProvider.fromEnvRecord({...}))` rather than mutating the
environment. The same holds in Amp: the plugin sees the environment it was started with (`amp orb restart-processes`
after changing secrets).

Node is pinned to 24 (`.node-version`): on Node 26, `Assert.deepStrictEqual` failures surface as
`TypeError: The "message" argument must be one of type string or function` instead of a diff, because
`@effect/vitest/utils` forwards an undefined message to `node:assert`.

### Toolchain

Mirrors the [Effect repository](https://github.com/Effect-TS/effect-smol): TypeScript 7 (`typescript@7`, the Go
compiler) with [`@effect/tsgo`](https://github.com/Effect-TS/tsgo) providing the Effect language service, `oxlint` with
the Effect type-aware rule preset, and `dprint` for formatting.

Editor setup: install the recommended VS Code extensions in `.vscode/extensions.json` (TypeScript Native Preview,
Effect, dprint, oxc).

### Dependency versions

`bun.lock` (installed with `--frozen-lockfile` in CI) makes every install reproducible; `package.json` ranges say what
we intend to accept. Upgrades arrive as CI-checked pull requests from [Renovate](https://docs.renovatebot.com/) using
`renovate.json` (enable the Mend Renovate GitHub App on the repository), never as silent floats.

| Dependency                                                | Range | Why                                                                                                                                                                                                                            |
| --------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `typescript`, `oxlint`, `oxlint-tsgolint`, `@effect/tsgo` | exact | `effect-tsgo patch` runs on `bun install` and fails if the versions are not on `@effect/tsgo`'s support table, so they are bumped together in one grouped PR that CI either accepts or rejects.                                |
| `@ampcode/plugin`                                         | exact | Published daily as `0.0.0-<date>-<sha>` under the `latest` dist-tag. A semver range resolves to the stale `0.0.0-dev` stub (alphanumeric prerelease identifiers sort above numeric ones), so Renovate follows the tag instead. |
| `effect`                                                  | `^`   | `^4.0.0-rc.N` accepts later release candidates, `4.0.0`, and `4.x`. Release candidates have renamed APIs, so each bump is a PR; Renovate's `rangeStrategy: bump` keeps the range's lower bound at the version actually tested. |
| `@types/bun`, `dprint`                                    | `^`   | Not coupled to anything.                                                                                                                                                                                                       |

## Contributing a plugin

1. `mkdir -p plugins/<name>/src` and add a `package.json` like `plugins/google-workspace/package.json`.
2. Write `src/index.ts` with a static `export const description = "…"` (≤ 300 characters) and a default export that
   builds a runtime and registers tools via `@scenesystems/amp-plugin-core`.
3. Add `{ "path": "./plugins/<name>" }` to the root `tsconfig.json` references.
4. `bun install && bun run ci`.

## License

[MIT](LICENSE) © Scene Systems
