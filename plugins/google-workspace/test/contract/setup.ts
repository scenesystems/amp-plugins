/**
 * Vitest setup for the contract project. Fails fast when the suite cannot run so that a missing
 * secret is a visible error, never a silently green run.
 *
 * Required environment:
 *   one complete credential the plugin accepts (the same variables it reads in Amp):
 *     GOOGLE_WORKLOAD_IDENTITY_PROVIDER + GOOGLE_SERVICE_ACCOUNT_EMAIL
 *       (+ GOOGLE_WORKLOAD_IDENTITY_TOKEN_FILE outside an orb, e.g. GitHub Actions' OIDC token), or
 *     GOOGLE_OAUTH_CLIENT_ID + GOOGLE_OAUTH_CLIENT_SECRET + GOOGLE_OAUTH_REFRESH_TOKEN, or
 *     GOOGLE_SERVICE_ACCOUNT_KEY | GOOGLE_SERVICE_ACCOUNT_KEY_FILE | GOOGLE_APPLICATION_CREDENTIALS
 *   GOOGLE_WORKSPACE_CONTRACT_FOLDER  Drive folder ID shared with that identity as Editor; every
 *                                     fixture file is created inside it and deleted afterwards.
 *
 * Only presence is checked here; the plugin's own `Credential.resolve` reports malformed values
 * with its production error messages when the suite runs.
 */
const isSet = (name: string): boolean => (process.env[name]?.trim() ?? "") !== ""

const credentialKinds: ReadonlyArray<{ readonly name: string; readonly all: ReadonlyArray<string> }> = [
  { name: "workload identity", all: ["GOOGLE_WORKLOAD_IDENTITY_PROVIDER", "GOOGLE_SERVICE_ACCOUNT_EMAIL"] },
  { name: "OAuth", all: ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", "GOOGLE_OAUTH_REFRESH_TOKEN"] },
  { name: "service account key", all: ["GOOGLE_SERVICE_ACCOUNT_KEY"] },
  { name: "service account key file", all: ["GOOGLE_SERVICE_ACCOUNT_KEY_FILE"] },
  { name: "service account key file", all: ["GOOGLE_APPLICATION_CREDENTIALS"] }
]

const problems: Array<string> = []
if (!credentialKinds.some((kind) => kind.all.every(isSet))) {
  problems.push(
    "a complete Google credential: " +
      credentialKinds.map((kind) => `${kind.name} (${kind.all.join(" + ")})`).join(", ")
  )
}
if (!isSet("GOOGLE_WORKSPACE_CONTRACT_FOLDER")) {
  problems.push("GOOGLE_WORKSPACE_CONTRACT_FOLDER (a Drive folder ID shared with that identity as Editor)")
}

if (problems.length > 0) {
  throw new Error(
    `Contract tests need ${problems.join(" and ")}. ` +
      "See plugins/google-workspace/skills/google-workspace/reference/setup.md, or run `bun run test` for the hermetic unit suite."
  )
}
