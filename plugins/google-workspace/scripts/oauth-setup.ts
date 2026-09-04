#!/usr/bin/env bun
/**
 * One-time helper to obtain a Google OAuth refresh token for the google-workspace Amp plugin.
 *
 * Run on a machine with a browser, from a clone of github.com/scenesystems/amp-plugins:
 *
 *   GOOGLE_OAUTH_CLIENT_ID=... GOOGLE_OAUTH_CLIENT_SECRET=... \
 *     bun run plugins/google-workspace/scripts/oauth-setup.ts [--read-only]
 *
 * Requires an OAuth client of type "Desktop app" (loopback redirect). Prints the refresh token and
 * the `amp secrets set --user ...` command that stores it as a personal secret.
 *
 * This is a developer-machine script, not plugin code: it uses `process.env`, `console`, and
 * `node:http` directly and is not part of the built plugin bundle.
 */
import * as Schema from "effect/Schema"
import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { createServer } from "node:http"
import { SCOPE_FULL, SCOPE_READ_ONLY } from "../src/Credential.ts"

const TokenExchange = Schema.Struct({
  refresh_token: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String),
  error_description: Schema.optionalKey(Schema.String)
})
const decodeTokenExchange = Schema.decodeUnknownSync(Schema.fromJsonString(TokenExchange))

const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim()
const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim()
if (!clientId || !clientSecret) {
  console.error("Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET in the environment first.")
  process.exit(1)
}

const readOnly = Bun.argv.includes("--read-only")
const scope = readOnly ? SCOPE_READ_ONLY : SCOPE_FULL
const state = randomBytes(16).toString("hex")

const openInBrowser = (url: string): void => {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open"
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url]
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref()
  } catch {
    // The user can copy the URL from the terminal instead.
  }
}

const server = createServer()
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
const address = server.address()
if (!address || typeof address === "string") {
  throw new Error("Could not bind loopback server")
}
const redirectUri = `http://127.0.0.1:${address.port}/callback`

const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth")
authUrl.search = new URLSearchParams({
  client_id: clientId,
  redirect_uri: redirectUri,
  response_type: "code",
  scope,
  access_type: "offline",
  prompt: "consent",
  state
}).toString()

console.log("\nOpen this URL in your browser to authorize the plugin:\n")
console.log(authUrl.toString())
console.log("\nWaiting for Google to redirect back to", redirectUri, "...\n")
openInBrowser(authUrl.toString())

const code = await new Promise<string>((resolve, reject) => {
  server.on("request", (req, res) => {
    const url = new URL(req.url ?? "/", redirectUri)
    if (url.pathname !== "/callback") {
      res.writeHead(404).end()
      return
    }
    const error = url.searchParams.get("error")
    if (error) {
      res.writeHead(400, { "content-type": "text/plain" }).end(`Authorization failed: ${error}`)
      reject(new Error(`Authorization failed: ${error}`))
      return
    }
    if (url.searchParams.get("state") !== state) {
      res.writeHead(400, { "content-type": "text/plain" }).end("State mismatch; try again.")
      reject(new Error("OAuth state mismatch"))
      return
    }
    const value = url.searchParams.get("code")
    if (!value) {
      res.writeHead(400, { "content-type": "text/plain" }).end("Missing code.")
      reject(new Error("Missing authorization code"))
      return
    }
    res
      .writeHead(200, { "content-type": "text/html" })
      .end("<h2>Amp google-workspace: authorized.</h2><p>You can close this tab and return to the terminal.</p>")
    resolve(value)
  })
})
server.close()

const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code"
  })
})
const token = decodeTokenExchange(await tokenResponse.text())
if (!tokenResponse.ok || !token.refresh_token) {
  console.error("Token exchange failed:", token.error, token.error_description ?? "")
  console.error(
    "If no refresh_token was returned, revoke the app at https://myaccount.google.com/permissions and retry."
  )
  process.exit(1)
}

console.log("Success. Store the refresh token as a PERSONAL Amp secret:\n")
console.log(
  `  printf %s '${token.refresh_token}' | amp secrets set --user GOOGLE_OAUTH_REFRESH_TOKEN --secret --data-file -\n`
)
console.log(
  "Make sure GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET are also set (workspace secrets are fine)."
)
if (readOnly) {
  console.log("This token was issued with the read-only scope; also set GOOGLE_WORKSPACE_READ_ONLY=1.")
}
