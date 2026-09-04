/**
 * Vitest configuration. Tests run with `@effect/vitest` on Node.
 *
 *   unit      packages/*\/test and plugins/*\/test, minus contract/. Hermetic: stub HTTP, in-memory FileSystem.
 *   contract  plugins/*\/test/contract. Hits the real Google APIs with GOOGLE_SERVICE_ACCOUNT_KEY and fails fast
 *             when credentials are missing (see plugins/google-workspace/test/contract/setup.ts). Never silently skipped.
 *
 * `bun test` (bunfig.toml) is reserved for scripts/bundle.test.ts, which loads the built bundle under Bun.
 */
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["packages/*/test/**/*.test.ts", "plugins/*/test/**/*.test.ts"],
          exclude: ["**/node_modules/**", "**/dist/**", "**/test/contract/**"]
        }
      },
      {
        test: {
          name: "contract",
          include: ["plugins/*/test/contract/**/*.test.ts"],
          setupFiles: ["plugins/google-workspace/test/contract/setup.ts"],
          testTimeout: 60_000,
          hookTimeout: 60_000,
          // Contract tests share one disposable fixture folder; run them one file at a time.
          fileParallelism: false
        }
      }
    ]
  }
})
