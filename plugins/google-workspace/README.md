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
- **Credentials**: keyless by default. Orbs prove their identity with `amp orb id-token` and Google's Workload
  Identity Federation exchanges that proof for a one-hour service-account token, so nothing long-lived is stored in
  Amp. OAuth (per person) and a service-account key (fallback) are also supported. Setup, precedence, and the
  permissions model are in [skills/google-workspace/reference/setup.md](skills/google-workspace/reference/setup.md);
  `scripts/google-setup.sh` provisions the Google Cloud side in one idempotent run.
- **Runtime**: Drive v3, Sheets v4, Docs v1, STS, and IAM Credentials REST APIs over Effect's `HttpClient`; the
  service-account JWT (key kind) is signed with WebCrypto. No Google SDKs.

## Configuration

Environment variables, supplied by Amp secrets in orbs (personal > project > workspace) or the shell locally. One
kind must be complete. Precedence: OAuth → workload identity → key. OAuth is selected by a refresh token, not by
client ID/secret alone; a selected kind's configuration or authentication failure never falls through.

**Read Drive as yourself, without changing the workspace default:** follow the
[personal read-only OAuth guide](skills/google-workspace/reference/setup.md#personal-read-only-access-keeping-the-workspace-robot).
Run the helper with `--manual --read-only` in an orb and approve in your normal browser. Paste the final callback into
its hidden prompt; it saves personal OAuth credentials and `GOOGLE_WORKSPACE_READ_ONLY=1` without printing tokens.
No orb Desktop or public callback server is needed; workspace WIF stays intact. Your account's Drive access replaces the robot's explicitly shared content for
your threads. Other members keep using the robot. Remove your personal refresh token and restart to return to it;
an expired token does not silently switch identities. Files read into threads follow the thread's visibility.

| Variable                                                                             | Kind              | Purpose                                                                                |
| ------------------------------------------------------------------------------------ | ----------------- | -------------------------------------------------------------------------------------- |
| `GOOGLE_WORKLOAD_IDENTITY_PROVIDER`                                                  | workload identity | `projects/<number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>` |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL`                                                       | workload identity | service account the orb impersonates                                                   |
| `GOOGLE_WORKLOAD_IDENTITY_TOKEN_FILE`                                                | workload identity | optional: read the OIDC token from a file (CI) instead of `amp orb id-token`           |
| `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REFRESH_TOKEN` | OAuth             | acts as one person; the refresh token belongs in personal secrets                      |
| `GOOGLE_SERVICE_ACCOUNT_KEY`                                                         | key               | service account key JSON (fallback when federation is impossible)                      |
| `GOOGLE_SERVICE_ACCOUNT_KEY_FILE` / `GOOGLE_APPLICATION_CREDENTIALS`                 | key               | path to the key JSON instead of inline                                                 |
| `GOOGLE_IMPERSONATE_USER`                                                            | robot kinds       | `<email>` or `amp-user`; domain-wide delegation subject                                |
| `GOOGLE_WORKSPACE_READ_ONLY`                                                         | all               | `1`/`true` requests the read-only scope and disables the three write tools             |

`printf '%s' VALUE | amp secrets set --workspace|--project|--user NAME --env|--secret --data-file -` sets one
non-interactively. In a running orb, `amp orb restart-processes` makes the plugin see changed values.

## Layout

```
plugins/google-workspace/
├── src/
│   ├── index.ts        plugin entry: description, Layer, tool/command/skill registration
│   ├── Tools.ts        the nine tools (Tool.make) and error → hint mapping
│   ├── Google.ts       Google service: typed Drive/Sheets/Docs calls, 401 retry, error parsing
│   ├── GoogleAuth.ts   GoogleAuth service: token minting per credential kind (STS exchange + impersonation,
│   │                   refresh token, or locally signed JWT) and caching
│   ├── SubjectToken.ts SubjectToken service: the orb's OIDC token via `amp orb id-token`, or a token file
│   ├── Credential.ts   credential resolution from Config (environment), precedence, read-only flag, scopes
│   ├── Model.ts        Schema models for API payloads
│   └── Format.ts       pure helpers: URL/ID parsing (FileRef schema), Drive queries, Markdown/CSV rendering
├── test/               Vitest + @effect/vitest (stubbed HttpClient, generated RSA key, fake `amp` on PATH,
│                       tools run through Tool.toPluginTool); test/contract/ hits the real APIs
├── scripts/google-setup.sh  Google Cloud provisioning for workload identity (gcloud; run on a workstation)
├── scripts/oauth-setup.ts   one-time per-user OAuth helper (run locally, not bundled)
└── skills/google-workspace/ SKILL.md + reference/setup.md (copied into the build)
```

```diagram
┌──────────┐   ┌─────────────┐   ┌──────────────┐   ┌────────────┐
│ Tools.ts │──▶│  Google.ts  │──▶│ GoogleAuth.ts│──▶│ Credential │
│ (Tool.   │   │ HttpClient  │   │ token cache  │   │ Config/env │
│  make)   │   │ + bearer    │   │ STS/JWT/     │   └────────────┘
└──────────┘   └─────────────┘   │ refresh      │──▶┌──────────────┐
                                 └──────────────┘   │ SubjectToken │
                                                    │ amp orb      │
                                                    │ id-token     │
                                                    └──────────────┘
```

## Develop

```bash
bun test plugins/google-workspace          # unit tests, no network
bun run build google-workspace             # dist/google-workspace/
```

To try a build inside Amp without installing it, copy `dist/google-workspace/` into
`~/.config/amp/plugins/google-workspace/`, run `plugins: reload` from the command palette, load the
`google-workspace` skill, and call `gdrive_whoami`.
