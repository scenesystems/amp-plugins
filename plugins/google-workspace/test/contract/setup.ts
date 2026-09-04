/**
 * Vitest setup for the contract project. Fails fast when the suite cannot run so that a missing
 * secret is a visible error, never a silently green run.
 *
 * Required environment:
 *   GOOGLE_SERVICE_ACCOUNT_KEY       service account JSON (any credential the plugin accepts works)
 *   GOOGLE_WORKSPACE_CONTRACT_FOLDER Drive folder ID shared with that identity as Editor; every
 *                                    fixture file is created inside it and deleted afterwards.
 */
const missing = ["GOOGLE_SERVICE_ACCOUNT_KEY", "GOOGLE_WORKSPACE_CONTRACT_FOLDER"].filter(
  (name) => !process.env[name]?.trim()
)

if (missing.length > 0) {
  throw new Error(
    `Contract tests need ${
      missing.join(" and ")
    }. Set them (a service account key and a Drive folder shared with it) ` +
      "or run `bun run test` for the hermetic unit suite."
  )
}
