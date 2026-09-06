---
name: google-workspace
description: Read, search, and review Google Docs, Sheets, Slides, and Drive files alongside code. Use whenever the user mentions a Google Doc/Sheet, pastes a docs.google.com or drive.google.com link, asks about specs, roadmaps, or data kept in Drive, or wants to write results back to a Sheet or Doc.
builtin-tools:
  - gdrive_whoami
  - gdrive_search
  - gdrive_file_info
  - gdocs_read
  - gsheets_read
  - gdrive_comments
  - gsheets_write
  - gdocs_append
  - gdrive_comment_add
---

# Google Workspace

Tools for working with Google Drive content from Amp. Every `file`/`folder` input accepts either a
raw Drive file ID or any Google URL (`https://docs.google.com/document/d/<id>/edit`,
`https://docs.google.com/spreadsheets/d/<id>/edit#gid=123`, `https://drive.google.com/drive/folders/<id>`).

## Workflow

1. If the user gave a link or ID, go straight to `gdocs_read`, `gsheets_read`, or `gdrive_file_info`.
   Do not search first.
2. If the user names a document without a link, call `gdrive_search` with a few distinctive words
   and `type` set to `docs` or `sheets`. Prefer `nameOnly: true` when the words are clearly a title.
   If several candidates match, ask which one instead of guessing.
3. Read Docs with `gdocs_read`. Output is Markdown, so headings, lists, and tables survive. Long
   documents are paged: when the result ends with a `truncated` note, call again with the given
   `startChar`. Read the whole document before summarizing or comparing it against code.
4. Read Sheets with `gsheets_read`. With no `range` you get the tab list and the first tab (or the
   tab from `#gid=` in the URL). Then request specific tabs or ranges, e.g. `range: "Backlog!A1:H200"`.
   Keep `maxRows` modest; ask for more only when needed.
5. For review work, call `gdrive_comments` to see open feedback and quoted passages before making
   recommendations. Use `gdrive_comment_add` to leave feedback in the document only when the user
   asks for it.
6. Writing back: `gsheets_write` (mode `update` to overwrite a range, `append` to add rows) and
   `gdocs_append` (plain text at the end of a Doc). Confirm destructive overwrites with the user
   first. If a write tool reports read-only mode, tell the user `GOOGLE_WORKSPACE_READ_ONLY` is set.

When comparing a document to code, quote the relevant document passage, then point at the specific
files or symbols it describes, and call out where they disagree.

## Troubleshooting

Every credential error names the failing step and carries a hint; relay both to the user rather
than paraphrasing.

- `No Google credentials configured` — nothing is set. Point the user at Setup below.
- `Google API error 404` or `403` — the identity cannot see the file. Run `gdrive_whoami` and tell
  the user which address the file (or its folder) must be shared with. A 404 from Google means
  "not shared with this identity", not "does not exist".
- `accessNotConfigured` — the Drive/Docs/Sheets APIs are not enabled in the Google Cloud project.
- `Could not run \`amp orb id-token\``or`exited with code`— workload identity is configured but
  this is not an orb (a laptop, or a runner). The user needs OAuth locally, or`GOOGLE_WORKLOAD_IDENTITY_TOKEN_FILE`.
- `Google STS token exchange failed` — the provider name is wrong, its attribute condition does not
  admit this Amp workspace, or it restricts allowed audiences. Re-run
  `google-setup.sh` with the right `--amp-workspace-id`.
- `generateAccessToken` or `signJwt` failed — the impersonation grant is missing
  (`roles/iam.workloadIdentityUser`, or `roles/iam.serviceAccountTokenCreator` with
  `GOOGLE_IMPERSONATE_USER`). `google-setup.sh` (with `--delegation`) adds it.
- `invalid_grant` — a revoked key or OAuth refresh token, or domain-wide delegation not authorized
  for this exact scope; re-run the matching setup step.
- After secrets change, `amp orb restart-processes` in a running orb; new orbs need nothing.

## Setup

Credentials come from environment variables: Amp secrets in orbs (personal > project > workspace),
the shell locally. The plugin acts as one Google identity and sees exactly what Drive shares with
it: share content with the robot, or use personal OAuth to access what the person can access.
`{baseDir}/reference/setup.md` is
the full guide, including the permissions model; the short version:

- **Workload identity** (default): keyless. A Google Cloud admin runs
  `plugins/google-workspace/scripts/google-setup.sh --project <gcp> --amp-workspace-id <uuid>` once
  from a clone of `github.com/scenesystems/amp-plugins`; it prints the two
  `amp secrets set --workspace … --env` commands (`GOOGLE_WORKLOAD_IDENTITY_PROVIDER`,
  `GOOGLE_SERVICE_ACCOUNT_EMAIL`). Orbs prove who they are with `amp orb id-token`; no secret is
  stored anywhere.
- **OAuth** (per person, works outside orbs): keep workspace WIF unchanged and store the OAuth
  client ID, client secret, and refresh token with `--user` (a team's client may instead be shared).
  In an orb run `bun run plugins/google-workspace/scripts/oauth-setup.ts --manual --read-only`:
  the user approves in their normal browser, then pastes the final callback URL into the helper's
  hidden terminal prompt after the expected loopback connection error. It saves personal OAuth
  and read-only configuration directly, without printing tokens. No orb Desktop needed. Never ask
  for callback URLs or tokens in chat. Personal OAuth overrides workspace WIF;
  an OAuth error does not fall back. Remove the personal refresh token and restart to use WIF again.
- **Service account key** (fallback when federation is forbidden): `google-setup.sh --key file.json`,
  stored as the workspace secret `GOOGLE_SERVICE_ACCOUNT_KEY`.
- `GOOGLE_IMPERSONATE_USER=<email>|amp-user` makes a robot credential act as a person (domain-wide
  delegation); `GOOGLE_WORKSPACE_READ_ONLY=1` requests the read-only scope and disables write tools.

When the user asks how to set this up, read `{baseDir}/reference/setup.md` and walk them through the
kind that fits; do not improvise console steps. The Amp command
`google-workspace: check Google credentials` (command palette) reports the resolved identity or the
exact configuration problem without spending a tool call.
