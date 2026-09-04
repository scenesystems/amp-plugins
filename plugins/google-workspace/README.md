# google-workspace

Amp plugin that lets the agent search Google Drive, read Google Docs as Markdown, read and write Google Sheets
ranges, and list or add review comments — so specs, roadmaps, and data kept in Drive can be reviewed alongside
code.

- **Tools** (gated behind the bundled `google-workspace` skill, so they cost no context in unrelated threads):
  `gdrive_whoami`, `gdrive_search`, `gdrive_file_info`, `gdocs_read`, `gsheets_read`, `gdrive_comments`,
  `gsheets_write`, `gdocs_append`, `gdrive_comment_add`. Every `file`/`folder` input accepts a Drive ID or any
  docs.google.com / drive.google.com URL (`#gid=` selects a sheet tab).
- **Command**: `google-workspace: check Google credentials` reports the identity Drive sees or the exact
  configuration problem.
- **Credentials**: environment variables, supplied by Amp secrets in orbs. See
  [skills/google-workspace/reference/setup.md](skills/google-workspace/reference/setup.md).
- **Runtime**: Drive v3, Sheets v4, and Docs v1 REST APIs over Effect's `HttpClient`; the service-account JWT is
  signed with WebCrypto. No Google SDKs.

## Configuration

| Variable                                                                             | Purpose                                                                    |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `GOOGLE_SERVICE_ACCOUNT_KEY`                                                         | Service account key JSON (recommended workspace secret)                    |
| `GOOGLE_SERVICE_ACCOUNT_KEY_FILE` / `GOOGLE_APPLICATION_CREDENTIALS`                 | Path to the key JSON instead of inline                                     |
| `GOOGLE_IMPERSONATE_USER`                                                            | `<email>` or `amp-user`; domain-wide delegation subject                    |
| `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REFRESH_TOKEN` | Personal OAuth grant; wins over the service account when all three are set |
| `GOOGLE_WORKSPACE_READ_ONLY`                                                         | `1`/`true` requests the read-only scope and disables the three write tools |

Set them with `amp secrets set --workspace|--user NAME --secret` (or `--env` for non-secret values). In a running
orb, `amp orb restart-processes` makes the plugin see changed secrets.

## Layout

```
plugins/google-workspace/
├── src/
│   ├── index.ts        plugin entry: description, Layer, tool/command/skill registration
│   ├── Tools.ts        the nine tools (Tool.make) and error → hint mapping
│   ├── Google.ts       Google service: typed Drive/Sheets/Docs calls, 401 retry, error parsing
│   ├── GoogleAuth.ts   GoogleAuth service: token minting (JWT bearer or refresh token) and caching
│   ├── Credential.ts   credential resolution from Config (environment), read-only flag, scopes
│   ├── Model.ts        Schema models for API payloads
│   └── Format.ts       pure helpers: URL/ID parsing (FileRef schema), Drive queries, Markdown/CSV rendering
├── test/               bun tests (stubbed HttpClient, generated RSA key, tools run through Tool.toPluginTool)
├── scripts/oauth-setup.ts   one-time per-user OAuth helper (run locally, not bundled)
└── skills/google-workspace/ SKILL.md + reference/setup.md (copied into the build)
```

```diagram
┌──────────┐   ┌─────────────┐   ┌──────────────┐   ┌────────────┐
│ Tools.ts │──▶│  Google.ts  │──▶│ GoogleAuth.ts│──▶│ Credential │
│ (Tool.   │   │ HttpClient  │   │ token cache  │   │ Config/env │
│  make)   │   │ + bearer    │   │ JWT / refresh│   └────────────┘
└──────────┘   └─────────────┘   └──────────────┘
```

## Develop

```bash
bun test plugins/google-workspace          # unit tests, no network
bun run build google-workspace             # dist/google-workspace/
```

To try a build inside Amp without installing it, copy `dist/google-workspace/` into
`~/.config/amp/plugins/google-workspace/`, run `plugins: reload` from the command palette, load the
`google-workspace` skill, and call `gdrive_whoami`.
