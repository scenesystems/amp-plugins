# Google Workspace plugin — credentials and access

The plugin calls the Drive, Docs, and Sheets APIs as some Google identity. Everything it can see or
change is exactly what that identity can see or change in Drive, narrowed by the OAuth scope the
plugin requests. Setup is therefore two decisions:

1. **Which identity** the plugin acts as, and how it proves it (this file, sections 1–4).
2. **What that identity is allowed to see**, which is plain Drive sharing (section 5).

Credentials are read from environment variables. In orbs those come from Amp secrets
(`amp secrets set`); on a laptop you export them in the shell. Plugin code never reads files it was
not pointed at and never writes credentials anywhere.

## 0. Choose a credential kind

| Kind                            | Acts as                   | Long-lived secret stored in Amp | Works                        | Set up by                    |
| ------------------------------- | ------------------------- | ------------------------------- | ---------------------------- | ---------------------------- |
| **Workload identity** (default) | a service account (robot) | none                            | in orbs (and CI via a token) | one Google Cloud admin, once |
| OAuth refresh token             | one person                | that person's refresh token     | everywhere                   | each person, once            |
| Service account key             | a service account (robot) | the private key                 | everywhere                   | one Google Cloud admin, once |

Precedence when more than one is configured: **OAuth → workload identity → key**. OAuth is the
per-person credential and normally lives in personal secrets, which is how a person who needs to
act as themselves overrides the workspace default. A partially configured kind (for example a
provider without a service account email) is an error, never a silent fall-through to another
identity.

Any robot kind (workload identity or key) can additionally act as a person through Google
Workspace **domain-wide delegation** (section 4).

Whatever you choose, verify with the command `google-workspace: check Google credentials` (Amp
command palette) or by asking Amp to run `gdrive_whoami`. Both report the resolved identity or the
exact configuration problem.

## 1. Workload identity (recommended)

Orbs can prove their identity: `amp orb id-token` mints a short-lived OIDC token signed by
ampcode.com that carries the Amp workspace, project, user, and thread ids. Google Cloud's Workload
Identity Federation verifies that token and lets the orb act as a service account for one hour.
Nothing long-lived exists: no key to store in Amp, rotate, or leak, and Google's audit logs record
which Amp thread and user performed each call.

```diagram
┌───────────────┐ amp orb id-token ┌──────────────┐  STS exchange   ┌──────────────────┐ generateAccessToken ┌────────────┐
│ orb (plugin)  │─────────────────▶│ ampcode.com  │────────────────▶│ Google STS       │────────────────────▶│ Drive API  │
│               │◀─────────────────│ signs OIDC   │◀────────────────│ verifies issuer, │◀────────────────────│ as the SA  │
└───────────────┘   OIDC token     └──────────────┘ federated token │ workspace, aud   │  1-hour SA token    └────────────┘
                                                                    └──────────────────┘
```

### One-time Google Cloud setup

You need `gcloud` on a workstation, authenticated as someone with Workload Identity Pool Admin,
Service Account Admin, and Service Usage Admin on a Google Cloud project (any project; a new one
called `amp-workspace` is fine). Find your Amp workspace id: ask Amp, or in an orb decode
`amp orb id-token --audience test` and read `workspace_id`.

```bash
git clone https://github.com/scenesystems/amp-plugins && cd amp-plugins
plugins/google-workspace/scripts/google-setup.sh \
  --project <gcp-project-id> \
  --amp-workspace-id <amp-workspace-uuid>
```

The script is idempotent and prints every step. It enables the APIs, creates the service account
`amp-google-workspace@<project>.iam.gserviceaccount.com`, creates the pool `amp-orbs` with a
provider `amp-oidc` that trusts `https://ampcode.com/api/workload-identity` and admits only tokens whose
`workspace_id` is yours, and grants `roles/iam.workloadIdentityUser` on the service account to that
workspace. Add `--dry-run` to see the `gcloud` commands first; `--amp-project-id <uuid>` narrows
trust to one Amp project; `--help` lists everything.

### Wire it into Amp

The script ends by printing the two commands, with your values filled in:

```bash
printf '%s' 'projects/<number>/locations/global/workloadIdentityPools/amp-orbs/providers/amp-oidc' \
  | amp secrets set --workspace GOOGLE_WORKLOAD_IDENTITY_PROVIDER --env --data-file -
printf '%s' 'amp-google-workspace@<project>.iam.gserviceaccount.com' \
  | amp secrets set --workspace GOOGLE_SERVICE_ACCOUNT_EMAIL --env --data-file -
```

These are `--env`, not `--secret`: neither value is confidential. Anyone who has them still needs a
token from an orb in your workspace. New orbs pick them up automatically; in an existing orb run
`amp orb restart-processes`.

Then share Drive content with the service account email (section 5) and verify with
`gdrive_whoami`.

### Outside an orb

`amp orb id-token` exists only inside orbs. On a laptop, use OAuth (section 2) — personal secrets
override the workspace's workload identity, so both coexist. Another runtime that has its own OIDC
token (CI, a scheduler) can write it to a file and set `GOOGLE_WORKLOAD_IDENTITY_TOKEN_FILE=<path>`;
the token must be issued for the audience `https://iam.googleapis.com/<provider name>` by an issuer
the pool trusts. `google-setup.sh --github-repository owner/repo` adds a GitHub Actions provider for
exactly this, and this repository's CI uses it for the contract tests.

### If the trust changes

Removing a member from the Amp workspace stops new tokens after their existing Amp credential
expires (up to 24 hours). Revoking everyone at once: delete the provider in Google Cloud, or remove
the `roles/iam.workloadIdentityUser` binding from the service account. There is no key to rotate.

## 2. OAuth refresh token (acts as one person)

Use this when someone must act as themselves: files that cannot be shared with a robot, or the
plugin should see exactly what that person sees. Each person does it once.

### Personal read-only access, keeping the workspace robot

Leave `GOOGLE_WORKLOAD_IDENTITY_PROVIDER` and `GOOGLE_SERVICE_ACCOUNT_EMAIL` in workspace
configuration unchanged. Store your OAuth configuration in personal (`--user`) secrets/variables.
Other members continue using the robot unless they configure their own OAuth token. OAuth accesses
files as you, without sharing them with the robot; it is not limited to a selected folder.

1. Select the Google Cloud project with the Drive, Docs, and Sheets APIs enabled. In **Google Auth
   Platform**, configure **Branding** (app name, support email, developer contact) and **Audience**.
   Choose **Internal** only for users belonging to the project's Google Workspace organization;
   otherwise choose **External**. For External apps in Testing, add your Google account as a test
   user. With Drive scopes, External/Testing refresh tokens expire after seven days. Internal apps
   avoid that testing restriction; production external apps may need verification for Drive's
   restricted scopes. Publishing does not guarantee tokens never expire or bypass admin policies.
2. In **Data Access**, configure `https://www.googleapis.com/auth/drive.readonly`. In **Clients →
   Create client**, select **Desktop app**. Keep its client ID and secret private while setting up;
   never paste the secret or downloaded client JSON into a thread. A `gcloud auth login` session
   is not the plugin's OAuth credential.
3. In the orb Terminal tab (or a local clone), use Bash to enter the client without putting
   literal credentials in shell history. The client ID is an identifier, not a URL: no `http://`,
   trailing slash, or embedded spaces. Sign the Amp CLI into your account first.

   ```bash
   read -r -p 'OAuth client ID: ' GOOGLE_OAUTH_CLIENT_ID
   read -r -s -p 'OAuth client secret: ' GOOGLE_OAUTH_CLIENT_SECRET; printf '\n'
   export GOOGLE_OAUTH_CLIENT_ID GOOGLE_OAUTH_CLIENT_SECRET
   bun run plugins/google-workspace/scripts/oauth-setup.ts --manual --read-only
   ```

   On a fresh local clone, run `bun install --frozen-lockfile` first; orb setup already installs
   dependencies. Keep `--read-only`: the helper otherwise requests full Drive access.
4. Open the printed authorization link in **your normal browser on your own device**, without
   introducing line breaks. No orb Desktop, public portal, or local CLI installation is needed.
   After approval, Google redirects to a loopback URL on your device; a connection error is
   expected. Copy the **complete final address-bar URL**, including `code` and `state`, into the
   helper's **hidden callback prompt in the orb terminal**, then press Enter. Do not paste it into
   chat or a shell command. Do not restart the helper or reuse a callback from an earlier run.

   Manual mode validates the callback address and state, uses PKCE, exchanges the code, and saves
   the client ID, client secret, read-only flag, and refresh token directly to **personal Amp
   configuration**. Secrets go over the Amp CLI's stdin, not arguments or printed commands. The
   refresh token is saved last; workspace WIF settings are never changed. A save failure is
   reported, not silently treated as success; earlier individual saves may already have completed.
   Once it reports success, clear the client values from your terminal:

   ```bash
   unset GOOGLE_OAUTH_CLIENT_ID GOOGLE_OAUTH_CLIENT_SECRET
   ```

   This still uses a Desktop client's loopback redirect, not Google's deprecated out-of-band
   redirect. Hidden input prevents terminal echo, not agent access to the shared orb. Revoke the
   Google app grant at https://myaccount.google.com/permissions if credentials are exposed.
5. In an existing orb, run `amp orb restart-processes`, then ask Amp to run `gdrive_whoami`.
   It must report an **OAuth user credential**, your Google email, and **read-only mode**. Read a
   known document to verify access. No write test is needed.

**Local-browser mode** (without `--manual`): run the helper and browser on the same computer.
The helper receives the callback automatically and prints a refresh-token storage command.
That output is secret. Use `--manual` to save directly to Amp without printing the token.

OAuth is selected when `GOOGLE_OAUTH_REFRESH_TOKEN` is present; the matching client ID and secret
must also be available. Client ID/secret alone do not override the robot. A configured OAuth token
that is expired, revoked, incomplete, or denied file access produces an error: the plugin never
silently retries as the service account. To return to the workspace robot, remove your personal
`GOOGLE_OAUTH_REFRESH_TOKEN` from Amp and restart the orb. Keep the workspace WIF variables intact.

For a team-wide OAuth app, the client ID and client secret may instead be workspace configuration,
but every person's refresh token must still be personal. The personal read-only flag keeps your
plugin in read-only mode even if the workspace default later enables writes.

## 3. Service account key (fallback)

Only when federation is impossible, for example an organization policy that forbids external
identity pools. A key is a long-lived private key: anyone holding it is the service account until
the key is deleted.

```bash
plugins/google-workspace/scripts/google-setup.sh --project <gcp-project-id> \
  --amp-workspace-id <amp-workspace-uuid> --key ./amp-google-workspace.json
amp secrets set --workspace GOOGLE_SERVICE_ACCOUNT_KEY --secret --data-file ./amp-google-workspace.json
rm ./amp-google-workspace.json
```

(Google Cloud's `iam.disableServiceAccountKeyCreation` organization policy blocks the `--key` step;
that policy is the reason workload identity is the default.) Locally, `GOOGLE_SERVICE_ACCOUNT_KEY`
may hold the JSON inline, or `GOOGLE_SERVICE_ACCOUNT_KEY_FILE` / the standard
`GOOGLE_APPLICATION_CREDENTIALS` may point at the file. Rotate by creating a new key, updating the
secret, then deleting the old key.

## 4. Acting as a person with a robot credential (domain-wide delegation)

Google Workspace organizations can let a service account act **as a user**, so the plugin sees what
that user sees with no explicit sharing. This is an organization-wide grant that an admin must make
deliberately.

1. Run `google-setup.sh` with `--delegation` (adds `roles/iam.serviceAccountTokenCreator` so orbs
   may sign delegation assertions with the service account). Keys can already do this.
2. In the Google Admin console: Security → Access and data control → API controls →
   **Domain-wide delegation** → Add new. Enter the service account's OAuth client id (the script
   prints it) and authorize the exact scope the plugin requests:
   `https://www.googleapis.com/auth/drive`, or `https://www.googleapis.com/auth/drive.readonly` when
   `GOOGLE_WORKSPACE_READ_ONLY` is set. The scope strings must match exactly.
3. Choose who is impersonated:

   ```bash
   printf '%s' 'amp-user' | amp secrets set --workspace GOOGLE_IMPERSONATE_USER --env --data-file -
   ```

   `amp-user` makes each thread act as the Amp user running it, which requires that person's Amp
   account email to be their Google Workspace email. A fixed address such as `docs-bot@example.com`
   makes every thread act as that one account. With delegation on, `gdrive_whoami` reports the
   impersonated person and sharing with the service account is no longer needed.

## 5. What the identity can see: scope × Drive sharing

Google grants a request the intersection of two things, and the plugin adds a third:

| Layer            | Set by                                       | Effect                                                                                            |
| ---------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| OAuth scope      | `GOOGLE_WORKSPACE_READ_ONLY`                 | `drive` (read and write) or `drive.readonly`; Google refuses writes under the read-only scope     |
| Drive permission | file/folder sharing, Shared Drive membership | Viewer sees content; Commenter can also add comments; Editor can also write cells and append text |
| Plugin gate      | `GOOGLE_WORKSPACE_READ_ONLY`                 | `gsheets_write`, `gdocs_append`, `gdrive_comment_add` refuse before any network call              |

Practical patterns:

- **One folder for Amp.** Create a folder (or a Shared Drive) named for the purpose, share it once
  with the service account, and move or shortcut documents into it. Everything inside inherits the
  permission; `gdrive_search` finds it; nothing outside is visible.
- **Commenter for review, Editor for write-back.** Review workflows (read Docs and Sheets, list
  comments) need Viewer; leaving comments needs Commenter; `gsheets_write` and `gdocs_append` need
  Editor and the full scope. Start with `GOOGLE_WORKSPACE_READ_ONLY=1` and Commenter; widen when a
  workflow needs it.
- **Shared Drives** are the cleanest grant for a team: add the service account as a member once,
  and the membership survives file moves, renames, and people leaving.
- **Google Workspace organizations that block external sharing** cannot share with an
  `…gserviceaccount.com` address unless the admin allow-lists the service account's Google Cloud
  project domain or uses delegation (section 4). The plugin reports such files as 404 with the
  identity to share with.
- **A 404 from Google means "not shared with this identity"**, not "does not exist". The plugin's
  message names the identity; that is the address to share with.

## 6. Where configuration lives in Amp

`amp secrets set` has three scopes with fixed precedence: **personal (`--user`) > project
(`--project`) > workspace (`--workspace`)**. Use them to express who acts as what:

- Workspace: `GOOGLE_WORKLOAD_IDENTITY_PROVIDER`, `GOOGLE_SERVICE_ACCOUNT_EMAIL`, optionally
  `GOOGLE_WORKSPACE_READ_ONLY`, `GOOGLE_OAUTH_CLIENT_ID` / `_SECRET`. The default identity for
  everyone.
- Project: a different service account for one repository (its own `GOOGLE_SERVICE_ACCOUNT_EMAIL`
  plus a `google-setup.sh --amp-project-id …` binding), or `GOOGLE_WORKSPACE_READ_ONLY` for a
  project that should never write.
- Personal: `GOOGLE_OAUTH_REFRESH_TOKEN` (with the client id/secret if they are not workspace
  values), or `GOOGLE_IMPERSONATE_USER` set to your own address.

Use `--env` for values that are not confidential (provider name, service account email, flags) so
they are readable with `amp secrets get`, and `--secret` for refresh tokens, client secrets, and
keys. Changing any of them affects new orbs immediately; run `amp orb restart-processes` in an
orb that is already running.

Threads are not private to the plugin: a document the plugin reads becomes part of the thread, and
the thread's visibility (private, workspace, unlisted) decides who can read that copy. Treat
workspace-wide credentials as workspace-wide read access to the shared folder.

## 7. Variables reference

| Variable                              | Kind              | Meaning                                                                                |
| ------------------------------------- | ----------------- | -------------------------------------------------------------------------------------- |
| `GOOGLE_WORKLOAD_IDENTITY_PROVIDER`   | workload identity | `projects/<number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>` |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL`        | workload identity | service account to impersonate                                                         |
| `GOOGLE_WORKLOAD_IDENTITY_TOKEN_FILE` | workload identity | optional path to an OIDC token; default is `amp orb id-token`                          |
| `GOOGLE_OAUTH_CLIENT_ID`              | OAuth             | Desktop-app OAuth client                                                               |
| `GOOGLE_OAUTH_CLIENT_SECRET`          | OAuth             | its secret                                                                             |
| `GOOGLE_OAUTH_REFRESH_TOKEN`          | OAuth             | one person's grant (personal secret)                                                   |
| `GOOGLE_SERVICE_ACCOUNT_KEY`          | key               | service account JSON, inline                                                           |
| `GOOGLE_SERVICE_ACCOUNT_KEY_FILE`     | key               | path to the JSON; `GOOGLE_APPLICATION_CREDENTIALS` is accepted as the standard alias   |
| `GOOGLE_IMPERSONATE_USER`             | robot kinds       | `<email>` or `amp-user`; domain-wide delegation subject                                |
| `GOOGLE_WORKSPACE_READ_ONLY`          | all               | `1`/`true`/`yes`/`on`: read-only scope and write tools disabled                        |
