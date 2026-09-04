# Google Workspace plugin — credential setup

The plugin needs a Google identity that can see your Docs and Sheets. It reads credentials from
environment variables, so in orbs you store them as Amp secrets and locally you export them in
your shell. Pick one of the two options.

## Prerequisite (both options): a Google Cloud project with the APIs enabled

1. Open https://console.cloud.google.com/ and create (or pick) a project, e.g. `amp-workspace`.
2. Enable these APIs (APIs & Services → Library):
   - Google Drive API
   - Google Docs API
   - Google Sheets API

## Option A — Service account (recommended for a shared workspace plugin)

A service account is a robot identity. Everyone in the workspace uses the same one, and it can
only see files that are shared with it.

1. IAM & Admin → Service Accounts → **Create service account** (name it `amp-google-workspace`).
   No project roles are needed.
2. Open the account → Keys → **Add key → Create new key → JSON**. Download the file.
3. Store the JSON as a workspace secret so every orb in the workspace gets it:

   ```bash
   amp secrets set --workspace GOOGLE_SERVICE_ACCOUNT_KEY --secret --data-file ./amp-google-workspace-key.json
   ```

   Locally: `export GOOGLE_SERVICE_ACCOUNT_KEY="$(cat ./amp-google-workspace-key.json)"`,
   `export GOOGLE_SERVICE_ACCOUNT_KEY_FILE=/path/to/key.json`, or the standard
   `GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json`.
4. Share your documents with the service account's email (`...@<project>.iam.gserviceaccount.com`).
   The easiest pattern: create one Drive folder (or a Shared Drive) for Amp-visible material and
   share the folder once; everything inside inherits access. Give it **Commenter** for read-only
   use, **Editor** if you want the write tools to work.
5. Delete the downloaded JSON file once it is stored.
6. Verify from any thread: ask Amp to run `gdrive_whoami`, or run the command
   `google-workspace: check Google credentials` from the palette.

### Optional: domain-wide delegation (Google Workspace organizations)

If your org is on Google Workspace and an admin is willing, the service account can act **as a
user** instead of needing explicit shares:

1. In the Google Admin console: Security → Access and data control → API controls →
   **Domain-wide delegation** → Add new. Enter the service account's Client ID and authorize the
   scope `https://www.googleapis.com/auth/drive` (or `.../drive.readonly` if you set
   `GOOGLE_WORKSPACE_READ_ONLY=1`; the scopes must match exactly).
2. Set who to impersonate:
   - `amp secrets set --workspace GOOGLE_IMPERSONATE_USER --env` with value `amp-user` — every
     thread acts as the Amp user who is running it (their Amp account email must match their
     Google Workspace email), or
   - a fixed email, e.g. `docs-bot@yourdomain.com`.

## Option B — OAuth refresh token (acts as you personally)

Use this when files cannot be shared with a robot or when you want the plugin to see exactly what
you see. Each person does this once.

1. APIs & Services → Credentials → **Create credentials → OAuth client ID**.
   Application type: **Desktop app**. Note the client ID and secret.
   (If the consent screen is in "Testing" mode, add your Google account as a test user.)
2. Share the client ID/secret with the workspace (they identify the app, not a person):

   ```bash
   amp secrets set --workspace GOOGLE_OAUTH_CLIENT_ID --env
   amp secrets set --workspace GOOGLE_OAUTH_CLIENT_SECRET --secret
   ```

3. On a machine with a browser, clone the plugin source repository and run the setup script:

   ```bash
   git clone https://github.com/scenesystems/amp-plugins && cd amp-plugins && bun install
   GOOGLE_OAUTH_CLIENT_ID=... GOOGLE_OAUTH_CLIENT_SECRET=... \
     bun run plugins/google-workspace/scripts/oauth-setup.ts
   ```

   It opens Google's consent page, receives the redirect on localhost, and prints the refresh
   token together with the exact `amp secrets set --user ...` command to store it as a personal
   secret. Add `--read-only` to request the read-only Drive scope.
4. Run the printed command. The refresh token is personal — never put it in workspace secrets.

Personal secrets override workspace secrets, so a person with a refresh token uses it while
everyone else falls back to the service account.

## Read-only mode

```bash
amp secrets set --workspace GOOGLE_WORKSPACE_READ_ONLY --env   # value: 1
```

This requests the `drive.readonly` scope and makes `gsheets_write`, `gdocs_append`, and
`gdrive_comment_add` refuse to run.

## Refreshing secrets in a running orb

New orbs get current secrets automatically. In an existing orb run `amp orb restart-processes`
after changing secrets so the plugin process sees the new values.
