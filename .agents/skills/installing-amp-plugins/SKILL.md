---
name: installing-amp-plugins
description: "Installs, updates, or removes prebuilt Amp plugins from a GitHub release (such as scenesystems/amp-plugins) into an Amp Workspace Plugins or Personal Plugins repository, a project's .amp/plugins, or ~/.config/amp/plugins. Use when asked to install, add, update, or share a plugin like google-workspace in an Amp workspace."
license: MIT
---

# Installing Amp Plugins

Amp loads plugins from its own locations, never from GitHub or npm. Repositories built like
[scenesystems/amp-plugins](https://github.com/scenesystems/amp-plugins) publish each plugin as a self-contained
`<plugin>.zip` on a GitHub Release. Installing means unpacking that zip into an Amp plugin location and, for shared
locations, committing and pushing.

## 1. Pick the scope

| Scope       | Location                                                          | Who gets it                    |
| ----------- | ----------------------------------------------------------------- | ------------------------------ |
| `workspace` | Workspace Plugins repository (`amp clone workspace-plugins`)      | everyone in the Amp workspace  |
| `user`      | Personal Plugins repository (`amp clone user-plugins`)            | the current user, everywhere   |
| `project`   | `./.amp/plugins/`                                                 | anyone running Amp in the repo |
| `system`    | `~/.config/amp/plugins/`                                          | this machine only              |

Use the scope the user named. If they said "our workspace", "the team", or "everyone", use `workspace`; a workspace
push requires workspace admin permission and affects all members, so confirm before pushing. If they said nothing,
default to `user` and say so. Run `amp plugins repositories` to see which repositories exist and are writable.

## 2. Install

Run `scripts/install-plugin.sh <owner/repo> <plugin> <scope> [tag]`, for example:

```sh
scripts/install-plugin.sh scenesystems/amp-plugins google-workspace workspace
```

The script downloads `<plugin>.zip` and `SHA256SUMS` from the latest release (or `tag`), verifies the checksum,
unpacks into the target, and for `workspace`/`user` commits in the repository clone under
`~/.cache/amp/repositories/ampcode.com-<scope>-plugins`. It never pushes. If the repository has no plugins yet the
script initialises the clone; the remote repository is created on the first push.

If the repository has no releases, build from source instead: clone it, `bun install --frozen-lockfile`,
`bun run build <plugin>`, and copy `dist/<plugin>/` into the target directory.

Review the installed files (`index.js`, `BUILD`, optional `skills/`, `README.md`) before publishing. Plugins execute
code; only install from repositories the user trusts. `BUILD` names the release tag and source commit the bundle was
built from; quote it when reporting what was installed or when debugging.

## 3. Publish and load

- `workspace`/`user`: show the commit (`git -C <clone> show --stat`) and ask, naming the destination, for example
  "Push this to the scene-systems Workspace Plugins repository so it goes live for everyone?" Push only after a yes:
  `git -C <clone> push -u origin main`. New threads pick the plugin up automatically; the current session after
  `plugins: reload` from the command palette.
- `project`/`system`: run `plugins: reload` (or ask Amp to reload plugins).

Check with `amp plugins list` that the plugin and its tools appear.

## 4. Configure secrets

Plugins read credentials from environment variables, never from files in the plugin. Open the installed plugin's
`README.md`, list the variables it needs (for google-workspace: `GOOGLE_SERVICE_ACCOUNT_KEY`, or the OAuth trio
described there), and tell the user to add them as Amp secrets at the matching scope (workspace secrets for a
workspace plugin). Secrets reach plugins as environment variables after the Amp process or orb is restarted.

## Updating or removing

- Update: rerun the install script; it replaces the plugin directory and commits only if files changed. Show
  `git -C <clone> show --stat` so the user can see what moved.
- Remove: `git -C <clone> rm -r <plugin>`, commit, and confirm before pushing. For `project`/`system`, delete the
  directory and reload plugins.
- Repository plugins use no `@amp-plugin` directive, so `amp plugins update` does not touch them; updates are
  explicit reinstalls. Releases are dated snapshots of the source repository (`vYYYY.MM.DD`), not per-plugin
  versions: compare the installed `BUILD` with the latest release to see whether an update exists.
