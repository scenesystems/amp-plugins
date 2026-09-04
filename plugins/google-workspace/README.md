# google-workspace

Amp plugin for Google Drive, Docs, and Sheets: search Drive, read Docs as Markdown, read and write Sheet ranges, and
review or add comments. Ships the `google-workspace` skill so the agent knows when and how to use the tools.

Status: Effect port in progress. `gdrive_whoami` is wired; Drive/Docs/Sheets tools follow.

## Configuration

Credentials come from environment variables, which Amp populates from secrets (`amp secrets set --workspace|--user
NAME --secret`). One of:

- `GOOGLE_SERVICE_ACCOUNT_KEY` (service account JSON) or `GOOGLE_SERVICE_ACCOUNT_KEY_FILE`; optionally
  `GOOGLE_IMPERSONATE_USER=<email>|amp-user` for domain-wide delegation.
- `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REFRESH_TOKEN` for a personal OAuth grant.

Set `GOOGLE_WORKSPACE_READ_ONLY=1` to disable the write tools.

## Install

Build with `bun run build google-workspace` from the repository root, then `amp plugins add ./dist/google-workspace`
or copy `dist/google-workspace/` into your Amp plugin repository.
