import { describe, it } from "@effect/vitest"
import * as Assert from "@effect/vitest/utils"
import { Assert as ExitAssert, Http } from "@scenesystems/amp-plugin-testing"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Ref from "effect/Ref"
import * as Credential from "../src/Credential.ts"
import { Google, GoogleApiError, layer as GoogleLayer } from "../src/Google.ts"
import { GoogleAuth } from "../src/GoogleAuth.ts"
import * as Model from "../src/Model.ts"

const DRIVE = "https://www.googleapis.com/drive/v3"
const SHEETS = "https://sheets.googleapis.com/v4"
const DOCS = "https://docs.googleapis.com/v1"

const serviceAccount: Credential.ServiceAccount = {
  _tag: "ServiceAccount",
  clientEmail: "sa@example-project.iam.gserviceaccount.com",
  privateKey: Redacted.make("unused"),
  tokenUri: "https://oauth2.googleapis.com/token",
  subject: Option.none()
}

/** A `GoogleAuth` that hands out `token-<n>` (n = number of invalidations so far) and counts invalidations. */
const fakeAuth = Effect.gen(function*() {
  const invalidations = yield* Ref.make(0)
  const layer = Layer.succeed(GoogleAuth)({
    credential: Effect.succeed(serviceAccount),
    scope: Effect.succeed(Credential.SCOPE_FULL),
    readOnly: Effect.succeed(false),
    accessToken: Effect.map(Ref.get(invalidations), (n) => Redacted.make(`token-${n}`)),
    invalidate: Ref.update(invalidations, (n) => n + 1)
  })
  return { invalidations: Ref.get(invalidations), layer }
})

const google = (stub: Http.Stub) =>
  Effect.gen(function*() {
    const auth = yield* fakeAuth
    const service = yield* Effect.provide(Google, GoogleLayer.pipe(Layer.provide([stub.layer, auth.layer])))
    return { service, invalidations: auth.invalidations }
  })

const file = {
  id: "1AbCdEfGhIjKlMnOpQrStUvWxYz",
  name: "Vision",
  mimeType: Model.MIME.doc,
  modifiedTime: "2026-09-01T10:00:00.000Z",
  webViewLink: "https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/edit",
  owners: [{ emailAddress: "ari@scenesystems.io", displayName: "Ari" }]
}

const bearer = (recorded: Http.Recorded) => recorded.request.headers["authorization"]

describe("Google request wiring", () => {
  it.effect("about: GET drive/v3/about with the user projection and a bearer token", () =>
    Effect.gen(function*() {
      const stub = Http.stub(() =>
        Http.jsonResponse({ user: { emailAddress: "sa@example.test", displayName: "Robot" } })
      )
      const { service } = yield* google(stub)
      Assert.deepStrictEqual(yield* service.about, { user: { emailAddress: "sa@example.test", displayName: "Robot" } })
      Assert.strictEqual(stub.requests.length, 1)
      const request = Http.request(stub, 0)
      Assert.strictEqual(Http.endpoint(request), `GET ${DRIVE}/about`)
      Assert.deepStrictEqual(Http.query(request), { fields: "user(emailAddress,displayName)" })
      Assert.strictEqual(bearer(request), "Bearer token-0")
    }))

  it.effect("getFile: GET files/{id} with FILE_FIELDS and supportsAllDrives, decoding to DriveFile", () =>
    Effect.gen(function*() {
      const stub = Http.stub(() => Http.jsonResponse({ ...file, kind: "drive#file", unknownField: 1 }))
      const { service } = yield* google(stub)
      Assert.assertEquals(yield* service.getFile(file.id), new Model.DriveFile(file))
      const request = Http.request(stub, 0)
      Assert.strictEqual(Http.endpoint(request), `GET ${DRIVE}/files/${file.id}`)
      Assert.deepStrictEqual(Http.query(request), { fields: Model.FILE_FIELDS, supportsAllDrives: "true" })
    }))

  it.effect("getFile: URL-encodes the file id", () =>
    Effect.gen(function*() {
      const stub = Http.stub(() => Http.jsonResponse(file))
      const { service } = yield* google(stub)
      yield* service.getFile("weird/id?x")
      Assert.strictEqual(Http.request(stub, 0).url.pathname, "/drive/v3/files/weird%2Fid%3Fx")
    }))

  it.effect("getFile: follows a shortcut to its target with a second request", () =>
    Effect.gen(function*() {
      const shortcut = {
        id: "1ShortcutId000000000",
        name: "Vision (shortcut)",
        mimeType: Model.MIME.shortcut,
        shortcutDetails: { targetId: file.id, targetMimeType: Model.MIME.doc }
      }
      const stub = Http.stub((_, index) => Http.jsonResponse(index === 0 ? shortcut : file))
      const { service } = yield* google(stub)
      Assert.assertEquals(yield* service.getFile(shortcut.id), new Model.DriveFile(file))
      Assert.deepStrictEqual(stub.requests.map(Http.endpoint), [
        `GET ${DRIVE}/files/${shortcut.id}`,
        `GET ${DRIVE}/files/${file.id}`
      ])
    }))

  it.effect("getFile: returns a shortcut without a target as-is", () =>
    Effect.gen(function*() {
      const dangling = { id: "1ShortcutId000000000", name: "Broken", mimeType: Model.MIME.shortcut }
      const stub = Http.stub(() => Http.jsonResponse(dangling))
      const { service } = yield* google(stub)
      Assert.assertEquals(yield* service.getFile(dangling.id), new Model.DriveFile(dangling))
      Assert.strictEqual(stub.requests.length, 1)
    }))

  it.effect("listFiles: GET files across all drives with the default page size and ordering", () =>
    Effect.gen(function*() {
      const stub = Http.stub(() => Http.jsonResponse({ files: [file], nextPageToken: "ignored" }))
      const { service } = yield* google(stub)
      Assert.assertEquals(yield* service.listFiles({ q: "trashed = false" }), [new Model.DriveFile(file)])
      const request = Http.request(stub, 0)
      Assert.strictEqual(Http.endpoint(request), `GET ${DRIVE}/files`)
      Assert.deepStrictEqual(Http.query(request), {
        q: "trashed = false",
        pageSize: "25",
        fields: `nextPageToken,files(${Model.FILE_FIELDS})`,
        supportsAllDrives: "true",
        includeItemsFromAllDrives: "true",
        corpora: "allDrives",
        orderBy: "modifiedTime desc"
      })
    }))

  it.effect.each([
    { pageSize: 0, sent: "1" },
    { pageSize: 1, sent: "1" },
    { pageSize: 40, sent: "40" },
    { pageSize: 100, sent: "100" },
    { pageSize: 1000, sent: "100" },
    { pageSize: -5, sent: "1" }
  ])("listFiles: clamps pageSize $pageSize to $sent", ({ pageSize, sent }) =>
    Effect.gen(function*() {
      const stub = Http.stub(() => Http.jsonResponse({}))
      const { service } = yield* google(stub)
      Assert.deepStrictEqual(yield* service.listFiles({ q: "q", pageSize, orderBy: "name" }), [])
      Assert.strictEqual(Http.query(Http.request(stub, 0))["pageSize"], sent)
      Assert.strictEqual(Http.query(Http.request(stub, 0))["orderBy"], "name")
    }))

  it.effect("exportFile: GET files/{id}/export?mimeType= and returns the body text", () =>
    Effect.gen(function*() {
      const stub = Http.stub(() => Http.textResponse("# Vision\n\nBody", 200, "text/markdown"))
      const { service } = yield* google(stub)
      Assert.strictEqual(yield* service.exportFile(file.id, "text/markdown"), "# Vision\n\nBody")
      const request = Http.request(stub, 0)
      Assert.strictEqual(Http.endpoint(request), `GET ${DRIVE}/files/${file.id}/export`)
      Assert.deepStrictEqual(Http.query(request), { mimeType: "text/markdown" })
    }))

  it.effect("downloadFile: GET files/{id}?alt=media across all drives", () =>
    Effect.gen(function*() {
      const stub = Http.stub(() => Http.textResponse("a,b\n1,2", 200, "text/csv"))
      const { service } = yield* google(stub)
      Assert.strictEqual(yield* service.downloadFile(file.id), "a,b\n1,2")
      const request = Http.request(stub, 0)
      Assert.strictEqual(Http.endpoint(request), `GET ${DRIVE}/files/${file.id}`)
      Assert.deepStrictEqual(Http.query(request), { alt: "media", supportsAllDrives: "true" })
    }))

  it.effect("createFile: POST files with name, mimeType, parents and the FILE_FIELDS projection", () =>
    Effect.gen(function*() {
      const stub = Http.stub(() =>
        Http.jsonResponse({ id: "1NewDoc0000000000000", name: "Contract Doc", mimeType: Model.MIME.doc })
      )
      const { service } = yield* google(stub)
      Assert.assertEquals(
        yield* service.createFile({ name: "Contract Doc", mimeType: Model.MIME.doc, parents: ["1Folder000000000000"] }),
        new Model.DriveFile({ id: "1NewDoc0000000000000", name: "Contract Doc", mimeType: Model.MIME.doc })
      )
      const request = Http.request(stub, 0)
      Assert.strictEqual(Http.endpoint(request), `POST ${DRIVE}/files`)
      Assert.deepStrictEqual(Http.query(request), { fields: Model.FILE_FIELDS, supportsAllDrives: "true" })
      Assert.strictEqual(request.request.headers["content-type"], "application/json")
      Assert.deepStrictEqual(Http.jsonBody(request), {
        name: "Contract Doc",
        mimeType: Model.MIME.doc,
        parents: ["1Folder000000000000"]
      })
    }))

  it.effect("deleteFile: DELETE files/{id} across all drives and accepts an empty 204", () =>
    Effect.gen(function*() {
      const stub = Http.stub(() => Http.emptyResponse(204))
      const { service } = yield* google(stub)
      Assert.strictEqual(yield* service.deleteFile(file.id), undefined)
      const request = Http.request(stub, 0)
      Assert.strictEqual(Http.endpoint(request), `DELETE ${DRIVE}/files/${file.id}`)
      Assert.deepStrictEqual(Http.query(request), { supportsAllDrives: "true" })
    }))

  describe("comments", () => {
    const comment = (id: string, extra: Record<string, unknown> = {}) => ({
      id,
      author: { displayName: "Ari", emailAddress: "ari@scenesystems.io", me: false },
      content: `comment ${id}`,
      createdTime: "2026-09-01T00:00:00Z",
      ...extra
    })

    it.effect("listComments: pages through every page with pageSize 100 and the COMMENT_FIELDS projection", () =>
      Effect.gen(function*() {
        const stub = Http.stub((_, index) =>
          Http.jsonResponse(
            index === 0
              ? { comments: [comment("c1")], nextPageToken: "page-2" }
              : { comments: [comment("c2")] }
          )
        )
        const { service } = yield* google(stub)
        const comments = yield* service.listComments(file.id, { includeResolved: false })
        Assert.deepStrictEqual(comments.map((c) => c.id), ["c1", "c2"])
        Assert.deepStrictEqual(stub.requests.map(Http.endpoint), [
          `GET ${DRIVE}/files/${file.id}/comments`,
          `GET ${DRIVE}/files/${file.id}/comments`
        ])
        Assert.deepStrictEqual(Http.query(Http.request(stub, 0)), { pageSize: "100", fields: Model.COMMENT_FIELDS })
        Assert.deepStrictEqual(Http.query(Http.request(stub, 1)), {
          pageSize: "100",
          fields: Model.COMMENT_FIELDS,
          pageToken: "page-2"
        })
      }))

    it.effect("listComments: drops deleted comments always and resolved ones unless asked", () =>
      Effect.gen(function*() {
        const body = {
          comments: [comment("open"), comment("resolved", { resolved: true }), comment("deleted", { deleted: true })]
        }
        const stub = Http.stub(() => Http.jsonResponse(body))
        const { service } = yield* google(stub)
        Assert.deepStrictEqual(
          (yield* service.listComments(file.id, { includeResolved: false })).map((c) => c.id),
          ["open"]
        )
        Assert.deepStrictEqual(
          (yield* service.listComments(file.id, { includeResolved: true })).map((c) => c.id),
          ["open", "resolved"]
        )
      }))

    it.effect("listComments: an empty listing is an empty array", () =>
      Effect.gen(function*() {
        const stub = Http.stub(() => Http.jsonResponse({}))
        const { service } = yield* google(stub)
        Assert.deepStrictEqual(yield* service.listComments(file.id, { includeResolved: true }), [])
      }))

    it.effect("createComment: POST files/{id}/comments with a JSON body and a minimal projection", () =>
      Effect.gen(function*() {
        const stub = Http.stub(() => Http.jsonResponse(comment("c9")))
        const { service } = yield* google(stub)
        Assert.assertEquals(yield* service.createComment(file.id, "Looks good"), new Model.DriveComment(comment("c9")))
        const request = Http.request(stub, 0)
        Assert.strictEqual(Http.endpoint(request), `POST ${DRIVE}/files/${file.id}/comments`)
        Assert.deepStrictEqual(Http.query(request), {
          fields: "id,content,createdTime,author(displayName,emailAddress)"
        })
        Assert.strictEqual(request.request.headers["content-type"], "application/json")
        Assert.deepStrictEqual(Http.jsonBody(request), { content: "Looks good" })
      }))
  })

  describe("sheets", () => {
    const sheetId = "1SheetId000000000000"
    const spreadsheet = {
      spreadsheetId: sheetId,
      spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${sheetId}/edit`,
      properties: { title: "Backlog" },
      sheets: [{
        properties: { sheetId: 0, title: "Roadmap", index: 0, gridProperties: { rowCount: 100, columnCount: 8 } }
      }]
    }

    it.effect("getSpreadsheet: GET spreadsheets/{id} with SPREADSHEET_FIELDS", () =>
      Effect.gen(function*() {
        const stub = Http.stub(() => Http.jsonResponse(spreadsheet))
        const { service } = yield* google(stub)
        Assert.assertEquals(yield* service.getSpreadsheet(sheetId), new Model.Spreadsheet(spreadsheet))
        const request = Http.request(stub, 0)
        Assert.strictEqual(Http.endpoint(request), `GET ${SHEETS}/spreadsheets/${sheetId}`)
        Assert.deepStrictEqual(Http.query(request), { fields: Model.SPREADSHEET_FIELDS })
      }))

    it.effect("getValues: GET values/{range} with formatted rendering by rows; missing values are []", () =>
      Effect.gen(function*() {
        const stub = Http.stub((_, index) =>
          Http.jsonResponse(
            index === 0 ? { range: "'My Tab'!A1:B2", values: [["a", 1], [true, null]] } : { range: "Empty!A1" }
          )
        )
        const { service } = yield* google(stub)
        Assert.deepStrictEqual(yield* service.getValues(sheetId, "'My Tab'!A1:B2"), [["a", 1], [true, null]])
        Assert.deepStrictEqual(yield* service.getValues(sheetId, "Empty!A1"), [])
        const request = Http.request(stub, 0)
        Assert.strictEqual(request.url.pathname, `/v4/spreadsheets/${sheetId}/values/'My%20Tab'!A1%3AB2`)
        Assert.deepStrictEqual(Http.query(request), {
          valueRenderOption: "FORMATTED_VALUE",
          dateTimeRenderOption: "FORMATTED_STRING",
          majorDimension: "ROWS"
        })
      }))

    it.effect("updateValues: PUT values/{range}?valueInputOption=USER_ENTERED with a ROWS body", () =>
      Effect.gen(function*() {
        const stub = Http.stub(() =>
          Http.jsonResponse({
            spreadsheetId: sheetId,
            updatedRange: "Roadmap!A1:B2",
            updatedRows: 2,
            updatedColumns: 2,
            updatedCells: 4
          })
        )
        const { service } = yield* google(stub)
        Assert.deepStrictEqual(yield* service.updateValues(sheetId, "Roadmap!A1:B2", [["a", 1], ["b", 2]]), {
          updatedRange: "Roadmap!A1:B2",
          updatedRows: 2,
          updatedColumns: 2,
          updatedCells: 4
        })
        const request = Http.request(stub, 0)
        Assert.strictEqual(Http.endpoint(request), `PUT ${SHEETS}/spreadsheets/${sheetId}/values/Roadmap!A1%3AB2`)
        Assert.deepStrictEqual(Http.query(request), { valueInputOption: "USER_ENTERED" })
        Assert.deepStrictEqual(Http.jsonBody(request), {
          range: "Roadmap!A1:B2",
          majorDimension: "ROWS",
          values: [["a", 1], ["b", 2]]
        })
      }))

    it.effect("appendValues: POST values/{range}:append inserting rows with USER_ENTERED parsing", () =>
      Effect.gen(function*() {
        const stub = Http.stub(() => Http.jsonResponse({ updates: { updatedRange: "Log!A5:B5", updatedRows: 1 } }))
        const { service } = yield* google(stub)
        Assert.deepStrictEqual(yield* service.appendValues(sheetId, "Log!A1", [["x", "=SUM(A1:A4)"]]), {
          updates: { updatedRange: "Log!A5:B5", updatedRows: 1 }
        })
        const request = Http.request(stub, 0)
        Assert.strictEqual(Http.endpoint(request), `POST ${SHEETS}/spreadsheets/${sheetId}/values/Log!A1:append`)
        Assert.deepStrictEqual(Http.query(request), {
          valueInputOption: "USER_ENTERED",
          insertDataOption: "INSERT_ROWS"
        })
        Assert.deepStrictEqual(Http.jsonBody(request), {
          range: "Log!A1",
          majorDimension: "ROWS",
          values: [["x", "=SUM(A1:A4)"]]
        })
      }))
  })

  describe("docs", () => {
    const docId = "1DocId00000000000000"

    it.effect("appendDocumentText: reads the body end index, then inserts just before the trailing newline", () =>
      Effect.gen(function*() {
        const stub = Http.stub((_, index) =>
          index === 0
            ? Http.jsonResponse({ body: { content: [{ endIndex: 1 }, { endIndex: 120 }, { endIndex: 245 }] } })
            : Http.jsonResponse({ documentId: docId, replies: [{}] })
        )
        const { service } = yield* google(stub)
        Assert.strictEqual(yield* service.appendDocumentText(docId, "\nDecision: ship"), undefined)
        Assert.deepStrictEqual(stub.requests.map(Http.endpoint), [
          `GET ${DOCS}/documents/${docId}`,
          `POST ${DOCS}/documents/${docId}:batchUpdate`
        ])
        Assert.deepStrictEqual(Http.query(Http.request(stub, 0)), { fields: "body(content(endIndex))" })
        Assert.deepStrictEqual(Http.jsonBody(Http.request(stub, 1)), {
          requests: [{ insertText: { location: { index: 244 }, text: "\nDecision: ship" } }]
        })
      }))

    it.effect.each([
      { name: "an empty body", body: {}, index: 1 },
      { name: "a body with no content", body: { body: {} }, index: 1 },
      { name: "a fresh document (end index 2)", body: { body: { content: [{ endIndex: 2 }] } }, index: 1 },
      { name: "an element without endIndex", body: { body: { content: [{}] } }, index: 1 }
    ])("appendDocumentText: inserts at index $index for $name", ({ body, index }) =>
      Effect.gen(function*() {
        const stub = Http.stub((_, i) => Http.jsonResponse(i === 0 ? body : {}))
        const { service } = yield* google(stub)
        yield* service.appendDocumentText(docId, "x")
        Assert.deepStrictEqual(Http.jsonBody(Http.request(stub, 1)), {
          requests: [{ insertText: { location: { index }, text: "x" } }]
        })
      }))
  })
})

describe("Google authentication and error handling", () => {
  it.effect("on 401 it invalidates the token and retries exactly once with the new token", () =>
    Effect.gen(function*() {
      const stub = Http.stub((_, index) =>
        index === 0 ? Http.jsonResponse({ error: { code: 401 } }, 401) : Http.jsonResponse(file)
      )
      const { invalidations, service } = yield* google(stub)
      Assert.assertEquals(yield* service.getFile(file.id), new Model.DriveFile(file))
      Assert.strictEqual(yield* invalidations, 1)
      Assert.deepStrictEqual(stub.requests.map(bearer), ["Bearer token-0", "Bearer token-1"])
    }))

  it.effect("a second 401 is reported, not retried again", () =>
    Effect.gen(function*() {
      const stub = Http.stub(() =>
        Http.jsonResponse({
          error: {
            code: 401,
            message: "Invalid Credentials",
            status: "UNAUTHENTICATED",
            errors: [{ reason: "authError" }]
          }
        }, 401)
      )
      const { invalidations, service } = yield* google(stub)
      const exit = yield* Effect.exit(service.getFile(file.id))
      ExitAssert.assertFails(
        exit,
        new GoogleApiError({ message: "Invalid Credentials", status: 401, reason: "authError" })
      )
      Assert.strictEqual(stub.requests.length, 2)
      Assert.strictEqual(yield* invalidations, 1)
    }))

  it.effect("maps a Google error body to message, status, and the first error's reason", () =>
    Effect.gen(function*() {
      const stub = Http.stub(() =>
        Http.jsonResponse(
          {
            error: {
              code: 404,
              message: "File not found: 1AbCdEfGhIjKlMnOpQrStUvWxYz.",
              status: "NOT_FOUND",
              errors: [{ domain: "global", reason: "notFound" }, { reason: "second" }]
            }
          },
          404
        )
      )
      const { service } = yield* google(stub)
      ExitAssert.assertFails(
        yield* Effect.exit(service.getFile(file.id)),
        new GoogleApiError({ message: "File not found: 1AbCdEfGhIjKlMnOpQrStUvWxYz.", status: 404, reason: "notFound" })
      )
    }))

  it.effect("uses the error status when the body carries no reasons", () =>
    Effect.gen(function*() {
      const stub = Http.stub(() =>
        Http.jsonResponse({ error: { message: "Forbidden", status: "PERMISSION_DENIED" } }, 403)
      )
      const { service } = yield* google(stub)
      ExitAssert.assertFails(
        yield* Effect.exit(service.about),
        new GoogleApiError({ message: "Forbidden", status: 403, reason: "PERMISSION_DENIED" })
      )
    }))

  it.effect("falls back to the raw body (capped at 500 chars) for a non-JSON error", () =>
    Effect.gen(function*() {
      const html = `<html>${"x".repeat(600)}</html>`
      const stub = Http.stub(() => Http.textResponse(html, 502, "text/html"))
      const { service } = yield* google(stub)
      ExitAssert.assertFails(
        yield* Effect.exit(service.about),
        new GoogleApiError({ message: html.slice(0, 500), status: 502, reason: undefined })
      )
    }))

  it.effect("falls back to the request URL for an empty error body", () =>
    Effect.gen(function*() {
      const stub = Http.stub(() => Http.emptyResponse(500))
      const { service } = yield* google(stub)
      ExitAssert.assertFails(
        yield* Effect.exit(service.exportFile(file.id, "text/plain")),
        new GoogleApiError({ message: `${DRIVE}/files/${file.id}/export`, status: 500, reason: undefined })
      )
    }))

  it.effect("reports a transport failure as status 0 with the HttpClientError tag", () =>
    Effect.gen(function*() {
      const stub = Http.failingTransport("getaddrinfo ENOTFOUND www.googleapis.com")
      const { service } = yield* google(stub)
      const error = ExitAssert.failureOf(yield* Effect.exit(service.about))
      Assert.assertInstanceOf(error, GoogleApiError)
      Assert.strictEqual(error.status, 0)
      Assert.strictEqual(error.reason, "HttpClientError")
      Assert.assertInclude(error.message, "getaddrinfo ENOTFOUND www.googleapis.com")
      Assert.strictEqual(stub.requests.length, 1, "transport failures are not retried")
    }))

  it.effect("reports a 200 that is not JSON as InvalidJson", () =>
    Effect.gen(function*() {
      const stub = Http.stub(() => Http.textResponse("<!doctype html>", 200, "text/html"))
      const { service } = yield* google(stub)
      const error = ExitAssert.failureOf(yield* Effect.exit(service.about))
      Assert.assertInstanceOf(error, GoogleApiError)
      Assert.strictEqual(error.status, 0)
      Assert.strictEqual(error.reason, "InvalidJson")
    }))

  it.effect("reports a JSON body that does not match the schema as Decode, naming the path", () =>
    Effect.gen(function*() {
      const stub = Http.stub(() => Http.jsonResponse({ id: 123, name: "Vision", mimeType: Model.MIME.doc }))
      const { service } = yield* google(stub)
      ExitAssert.assertFails(
        yield* Effect.exit(service.getFile(file.id)),
        new GoogleApiError({
          message: "Unexpected response shape: Expected string\n  at [\"id\"]",
          status: 0,
          reason: "Decode"
        })
      )
    }))

  it.effect("propagates a credential failure from GoogleAuth without calling Google", () =>
    Effect.gen(function*() {
      const stub = Http.script()
      const credentialError = new Credential.CredentialError({ message: "No Google credentials configured." })
      const auth = Layer.succeed(GoogleAuth)({
        credential: Effect.fail(credentialError),
        scope: Effect.succeed(Credential.SCOPE_FULL),
        readOnly: Effect.succeed(false),
        accessToken: Effect.fail(credentialError),
        invalidate: Effect.void
      })
      const service = yield* Effect.provide(Google, GoogleLayer.pipe(Layer.provide([stub.layer, auth])))
      ExitAssert.assertFails(yield* Effect.exit(service.about), credentialError)
      Assert.strictEqual(stub.requests.length, 0)
    }))
})
