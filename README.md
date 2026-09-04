# amp-plugins

Reusable [Amp](https://ampcode.com) plugins, written in [Effect](https://effect.website) 4 and built with
[Bun](https://bun.sh). Each plugin bundles to a single directory you can install in Amp directly or copy into your own
User or Workspace plugin repository.

| Plugin                                       | Status   | What it adds                                                                  |
| -------------------------------------------- | -------- | ----------------------------------------------------------------------------- |
| [google-workspace](plugins/google-workspace) | skeleton | Google Drive search, Docs as Markdown, Sheets ranges, comments; bundled skill |

## Install a plugin

Download the built directory for a plugin from the latest CI run (or build it yourself, below), then either:

- add it to one machine: `amp plugins add ./dist/google-workspace`
- share it with your Amp workspace: copy `dist/google-workspace/` into your Workspace Plugins repository
  (`amp plugins repositories` prints its URL) and push.

Bundles are self-contained (Effect and shared code are inlined), so Amp needs no `bun install` to run them.

## Develop

Requires Bun ≥ 1.3.

```sh
bun install          # also patches tsc/oxlint with the Effect language service (@effect/tsgo)
bun run check        # TypeScript 7 (tsgo), all workspace projects
bun run lint         # oxlint (type-aware Effect rules) + dprint
bun test
bun run build        # dist/<plugin>/ for every plugin, or `bun run build google-workspace`
```

To try a build inside Amp without installing it, copy `dist/<plugin>/` into `~/.config/amp/plugins/<plugin>/` and run
`plugins: reload` from the command palette.

### Layout

```
packages/core/            @scenesystems/amp-plugin-core — Effect ↔ Amp Plugin API adapters
plugins/<name>/           one directory plugin per package
  src/index.ts            plugin entry: `export const description` + default export
  skills/<skill>/SKILL.md bundled Agent Skills (optional)
  test/                   bun tests
scripts/build.ts          bundles plugins/* → dist/*
```

`packages/core` gives you `Tool.make` (Schema-typed tool input, Effect body, errors rendered for the agent),
`Runtime.make` (a `ManagedRuntime` from your `Layer`, disposed with the plugin), and the `Amp` service exposing the
`PluginAPI` inside Effect code.

### Toolchain

Mirrors the [Effect repository](https://github.com/Effect-TS/effect-smol): TypeScript 7 (`typescript@7`, the Go
compiler) with [`@effect/tsgo`](https://github.com/Effect-TS/tsgo) providing the Effect language service, `oxlint` with
the Effect type-aware rule preset, and `dprint` for formatting. Versions of `typescript`, `oxlint`, `oxlint-tsgolint`,
and `@effect/tsgo` are pinned exactly because `@effect/tsgo` patches the other three and validates their versions.

Editor setup: install the recommended VS Code extensions in `.vscode/extensions.json` (TypeScript Native Preview,
Effect, dprint, oxc).

## Contributing a plugin

1. `mkdir -p plugins/<name>/src` and add a `package.json` like `plugins/google-workspace/package.json`.
2. Write `src/index.ts` with a static `export const description = "…"` (≤ 300 characters) and a default export that
   builds a runtime and registers tools via `@scenesystems/amp-plugin-core`.
3. Add `{ "path": "./plugins/<name>" }` to the root `tsconfig.json` references.
4. `bun install && bun run ci`.

## License

[MIT](LICENSE) © Scene Systems
