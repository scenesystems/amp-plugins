import { describe, expect, it } from "@scenesystems/amp-plugin-testing"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import * as Credential from "../src/Credential.ts"
import { Google, layer as GoogleLayer } from "../src/Google.ts"
import { GoogleAuth } from "../src/GoogleAuth.ts"
import { jsonResponse, type Recorded, type Reply, stubClient, textResponse } from "./support.ts"

const Files = "https://www.googleapis.com/drive/v3/files"
const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))

/** `GoogleAuth` that hands out `token-<n>` and counts invalidations, without any network. */
const fakeAuth = Layer.effect(GoogleAuth)(
  Effect.gen(function*() {
    const generation = yield* Ref.make(0)
    const credential: Credential.OAuthRefresh = {
      _tag: "OAuthRefresh",
      clientId: "cid",
      clientSecret: Redacted.make("s"),
      refreshToken: Redacted.make("r")
    }
    return GoogleAuth.of({
      credential: Effect.succeed(credential),
      scope: Effect.succeed(Credential.SCOPE_FULL),
      readOnly: Effect.succeed(false),
      accessToken: Effect.map(Ref.get(generation), (n) => Redacted.make(`token-${n}`)),
      invalidate: Ref.update(generation, (n) => n + 1)
    })
  })
)

const google = (reply: Reply) => {
  const http = stubClient(reply)
  const run = <A, E>(program: Effect.Effect<A, E, Google>) =>
    program.pipe(Effect.provide(GoogleLayer.pipe(Layer.provide(fakeAuth), Layer.provide(http.layer))))
  return { ...http, run }
}

const authorization = ({ request }: Recorded) => request.headers["authorization"]

const path = ({ url }: Recorded) => `${url.pathname}?${url.searchParams.toString()}`

const file = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: `File ${id}`,
  mimeType: "application/vnd.google-apps.document",
  ...extra
})

describe("Google request handling", () => {
  it.effect("sends a bearer token and decodes JSON", () =>
    Effect.gen(function*() {
      const api = google(() => jsonResponse({ user: { emailAddress: "sa@p.iam.gserviceaccount.com" } }))
      const about = yield* api.run(Google.use((g) => g.about))
      expect(about.user?.emailAddress).toBe("sa@p.iam.gserviceaccount.com")
      expect(authorization(api.requests[0]!)).toBe("Bearer token-0")
      expect(path(api.requests[0]!)).toBe("/drive/v3/about?fields=user%28emailAddress%2CdisplayName%29")
    }))

  it.effect("on 401 invalidates the token and retries exactly once", () =>
    Effect.gen(function*() {
      const api = google((_recorded, index) =>
        index === 0
          ? jsonResponse({ error: { code: 401, message: "Invalid Credentials" } }, 401)
          : jsonResponse(file("A"))
      )
      const result = yield* api.run(Google.use((g) => g.getFile("A")))
      expect(result.id).toBe("A")
      expect(api.requests.map(authorization)).toEqual(["Bearer token-0", "Bearer token-1"])
    }))

  it.effect("does not retry a second 401", () =>
    Effect.gen(function*() {
      const api = google(() =>
        jsonResponse({ error: { code: 401, message: "Invalid Credentials", status: "UNAUTHENTICATED" } }, 401)
      )
      const error = yield* Effect.flip(api.run(Google.use((g) => g.getFile("A"))))
      expect(error._tag).toBe("GoogleApiError")
      expect(error).toMatchObject({ status: 401, message: "Invalid Credentials", reason: "UNAUTHENTICATED" })
      expect(api.requests).toHaveLength(2)
    }))

  it.effect("surfaces Google's error message and reason", () =>
    Effect.gen(function*() {
      const api = google(() =>
        jsonResponse(
          {
            error: {
              code: 403,
              message: "Drive API has not been used in project 123 before or it is disabled.",
              errors: [{ reason: "accessNotConfigured", domain: "usageLimits" }],
              status: "PERMISSION_DENIED"
            }
          },
          403
        )
      )
      const error = yield* Effect.flip(api.run(Google.use((g) => g.about)))
      expect(error).toMatchObject({
        _tag: "GoogleApiError",
        status: 403,
        reason: "accessNotConfigured",
        message: "Drive API has not been used in project 123 before or it is disabled."
      })
    }))

  it.effect("falls back to the body text for non-JSON errors", () =>
    Effect.gen(function*() {
      const api = google(() => textResponse("<html>Bad Gateway</html>", 502))
      const error = yield* Effect.flip(api.run(Google.use((g) => g.about)))
      expect(error).toMatchObject({ _tag: "GoogleApiError", status: 502, message: "<html>Bad Gateway</html>" })
      expect(error._tag === "GoogleApiError" && error.reason).toBeUndefined()
    }))

  it.effect("reports a response that does not match the schema as status 0 / Decode", () =>
    Effect.gen(function*() {
      const api = google(() => jsonResponse({ id: 42 }))
      const error = yield* Effect.flip(api.run(Google.use((g) => g.getFile("A"))))
      expect(error).toMatchObject({ status: 0, reason: "Decode" })
      expect(error.message).toContain("Unexpected response shape")
    }))
})

describe("Google.getFile", () => {
  it.effect("follows shortcuts to their target", () =>
    Effect.gen(function*() {
      const api = google(({ url }) =>
        url.pathname.endsWith("/files/S")
          ? jsonResponse(
            file("S", { mimeType: "application/vnd.google-apps.shortcut", shortcutDetails: { targetId: "T" } })
          )
          : jsonResponse(file("T"))
      )
      const result = yield* api.run(Google.use((g) => g.getFile("S")))
      expect(result.id).toBe("T")
      expect(api.requests).toHaveLength(2)
    }))
})

describe("Google.listComments", () => {
  it.effect("walks every page and drops deleted and resolved comments by default", () =>
    Effect.gen(function*() {
      const pages = [
        {
          nextPageToken: "p2",
          comments: [
            { id: "c1", content: "open" },
            { id: "c2", content: "resolved", resolved: true }
          ]
        },
        {
          comments: [
            { id: "c3", content: "deleted", deleted: true },
            { id: "c4", content: "also open" }
          ]
        }
      ]
      const api = google(({ url }) => jsonResponse(url.searchParams.get("pageToken") === "p2" ? pages[1] : pages[0]))
      const open = yield* api.run(Google.use((g) => g.listComments("F", { includeResolved: false })))
      expect(open.map((c) => c.id)).toEqual(["c1", "c4"])
      expect(api.requests).toHaveLength(2)
      expect(api.requests[0]!.url.searchParams.has("pageToken")).toBe(false)
      expect(api.requests[1]!.url.searchParams.get("pageToken")).toBe("p2")

      const all = yield* api.run(Google.use((g) => g.listComments("F", { includeResolved: true })))
      expect(all.map((c) => c.id)).toEqual(["c1", "c2", "c4"])
    }))
})

describe("Google.listFiles", () => {
  it.effect("clamps pageSize to 1..100 and searches all drives", () =>
    Effect.gen(function*() {
      const api = google(() => jsonResponse({ files: [file("A")] }))
      const files = yield* api.run(Google.use((g) => g.listFiles({ q: "trashed = false", pageSize: 500 })))
      expect(files.map((f) => f.id)).toEqual(["A"])
      const params = api.requests[0]!.url.searchParams
      expect(api.requests[0]!.url.href).toStartWith(Files)
      expect(params.get("pageSize")).toBe("100")
      expect(params.get("q")).toBe("trashed = false")
      expect(params.get("includeItemsFromAllDrives")).toBe("true")
      expect(params.get("orderBy")).toBe("modifiedTime desc")
    }))
})

describe("Google.appendDocumentText", () => {
  it.effect("inserts before the trailing newline of the body", () =>
    Effect.gen(function*() {
      const api = google(({ request }) =>
        request.method === "GET"
          ? jsonResponse({ body: { content: [{ endIndex: 1 }, { endIndex: 120 }] } })
          : jsonResponse({ replies: [] })
      )
      yield* api.run(Google.use((g) => g.appendDocumentText("D", "\nHello")))
      const { request: update, url } = api.requests[1]!
      expect(update.method).toBe("POST")
      expect(url.href).toBe("https://docs.googleapis.com/v1/documents/D:batchUpdate")
      expect(update.body._tag).toBe("Uint8Array")
      if (update.body._tag === "Uint8Array") {
        const body = yield* decodeJson(new TextDecoder().decode(update.body.body))
        expect(body).toEqual({
          requests: [{ insertText: { location: { index: 119 }, text: "\nHello" } }]
        })
      }
    }))
})
