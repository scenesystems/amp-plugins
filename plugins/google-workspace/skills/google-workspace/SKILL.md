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

- `No Google credentials configured` — credentials are not set. Point the user at the Setup
  section below.
- `Google API error 404` or `403` — the identity cannot see the file. Run `gdrive_whoami` and tell
  the user which email the file (or its folder) must be shared with.
- `accessNotConfigured` — the Drive/Docs/Sheets APIs are not enabled in the Google Cloud project.
- `invalid_grant` while minting a token — the service account key was revoked or the OAuth refresh
  token was revoked/expired; re-run setup.
- After the user adds or changes secrets in an orb, run `amp orb restart-processes` so the plugin
  process receives the new environment.

## Setup

Credentials are read from environment variables. In orbs these come from Amp secrets
(Workspace → Project → Personal precedence); locally set them in your shell. Read
`{baseDir}/reference/setup.md` for step-by-step instructions covering:

- Option A (recommended for a team): a Google service account key in the workspace secret
  `GOOGLE_SERVICE_ACCOUNT_KEY`, with files or a shared folder shared to the service account email.
  Optional `GOOGLE_IMPERSONATE_USER=<email>|amp-user` for domain-wide delegation.
- Option B (per person): OAuth client + refresh token in personal secrets `GOOGLE_OAUTH_CLIENT_ID`,
  `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REFRESH_TOKEN`, produced by running
  `bun run plugins/google-workspace/scripts/oauth-setup.ts` from a clone of
  `github.com/scenesystems/amp-plugins` on a machine with a browser.
- `GOOGLE_WORKSPACE_READ_ONLY=1` to disable the write tools workspace-wide.

The Amp command `google-workspace: check Google credentials` (command palette) reports the resolved
identity or the exact configuration problem without spending a tool call.
