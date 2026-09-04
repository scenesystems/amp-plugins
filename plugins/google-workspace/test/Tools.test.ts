/**
 * Tool behaviour as the agent sees it.
 *
 * Every test registers the real tool set against a fake Amp API through `Runtime.make` and
 * `Tool.registerAll`, then calls the registered `execute` with raw JSON input, exactly as Amp does.
 * The Google service is a recording fake, so each test asserts both the full text the agent reads
 * and the exact sequence of Google calls that produced it.
 */
import { describe, it } from "@effect/vitest"
import * as Assert from "@effect/vitest/utils"
import { Runtime, Tool } from "@scenesystems/amp-plugin-core"
import { PluginApi } from "@scenesystems/amp-plugin-testing"
import * as Arr from "effect/Array"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { GoogleApiError } from "../src/Google.ts"
import * as Model from "../src/Model.ts"
import * as Tools from "../src/Tools.ts"
import * as Services from "./support/services.ts"

// --- fixtures ----------------------------------------------------------------------------------

const DOC_ID = "1DocVision0000000000"
const DOC_LINK = `https://docs.google.com/document/d/${DOC_ID}/edit`
const doc = new Model.DriveFile({
  id: DOC_ID,
  name: "Vision",
  mimeType: Model.MIME.doc,
  modifiedTime: "2026-09-01T10:00:00Z",
  webViewLink: DOC_LINK,
  owners: [{ emailAddress: "ari@scenesystems.io", displayName: "Ari" }]
})
const docHeader = [
  "# Vision",
  "- Type: Google Doc",
  `- ID: ${DOC_ID}`,
  `- Link: ${DOC_LINK}`,
  "- Modified: 2026-09-01T10:00:00Z",
  "- Owner: ari@scenesystems.io"
].join("\n")

const SHEET_ID = "1SheetRoadmap00000000"
const SHEET_LINK = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`
const sheet = new Model.DriveFile({
  id: SHEET_ID,
  name: "Roadmap",
  mimeType: Model.MIME.sheet,
  webViewLink: SHEET_LINK
})
const sheetHeader = ["# Roadmap", "- Type: Google Sheet", `- ID: ${SHEET_ID}`, `- Link: ${SHEET_LINK}`].join("\n")
const spreadsheet = new Model.Spreadsheet({
  spreadsheetId: SHEET_ID,
  properties: { title: "Roadmap" },
  spreadsheetUrl: SHEET_LINK,
  sheets: [
    { properties: { sheetId: 0, title: "Backlog", gridProperties: { rowCount: 100, columnCount: 6 } } },
    { properties: { sheetId: 734, title: "Q4 Plan" } }
  ]
})
const emptySpreadsheet = new Model.Spreadsheet({
  spreadsheetId: SHEET_ID,
  properties: { title: "Roadmap" },
  sheets: []
})
const rows: Model.Rows = [["Item", "Owner"], ["Auth", "Ari"], ["Billing", "Sam"]]

const folder = new Model.DriveFile({ id: "1Folder0000000000000", name: "Specs", mimeType: Model.MIME.folder })
const slides = new Model.DriveFile({ id: "1Slides000000000000", name: "Pitch", mimeType: Model.MIME.slides })
const csv = new Model.DriveFile({ id: "1Csv0000000000000000", name: "export.csv", mimeType: "text/csv" })
const png = new Model.DriveFile({ id: "1Png0000000000000000", name: "photo.png", mimeType: "image/png" })

const ENABLE_APIS_HINT =
  "Enable the Google Drive API, Google Docs API, and Google Sheets API in the Google Cloud project that owns these credentials."
const READ_ONLY_REFUSAL =
  "Error: Write tools are disabled because GOOGLE_WORKSPACE_READ_ONLY is set.\nHint: Unset it (and run `amp orb restart-processes` in an orb) to enable writes."
const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

class Boom extends Schema.TaggedError<Boom>()("Boom", { message: Schema.String }) {}

// --- harness -----------------------------------------------------------------------------------

interface Harness {
  /** Calls a registered tool with raw (undecoded) input, as Amp does, and reads its text result. */
  readonly call: (
    name: string,
    input: Record<string, unknown>
  ) => Effect.Effect<string, PluginApi.UnknownRegistration | PluginApi.NotText>
  readonly calls: ReadonlyArray<Services.Call>
  readonly amp: PluginApi.Fake
}

const harness = (options: { readonly google?: Services.Stubs; readonly auth?: Services.AuthOptions } = {}) =>
  Effect.gen(function*() {
    const amp = PluginApi.make()
    const google = Services.google(options.google ?? {})
    const runtime = Runtime.make(amp.api, Layer.mergeAll(google.layer, Services.auth(options.auth)))
    Tool.registerAll(amp.api, runtime, Tools.all)
    yield* Effect.addFinalizer(() => amp.dispose)
    const result: Harness = {
      call: (name, input) => Effect.flatMap(amp.execute(name, input), PluginApi.text),
      get calls() {
        return google.calls
      },
      amp
    }
    return result
  })

const fail = (error: GoogleApiError) => () => Effect.fail(error)

// --- gdrive_whoami -------------------------------------------------------------------------------

describe("gdrive_whoami", () => {
  it.effect("reports a service account, the Drive identity, the scope, and who to share files with", () =>
    Effect.gen(function*() {
      const h = yield* harness({
        google: {
          about: Effect.succeed({
            user: { emailAddress: "robot@example-project.iam.gserviceaccount.com", displayName: "Robot" }
          })
        }
      })
      Assert.strictEqual(
        yield* h.call("gdrive_whoami", {}),
        [
          "Credential: service account robot@example-project.iam.gserviceaccount.com",
          "Drive identity: robot@example-project.iam.gserviceaccount.com (Robot)",
          "Scope: https://www.googleapis.com/auth/drive",
          "Files must be shared with robot@example-project.iam.gserviceaccount.com (or live in a folder/shared drive it can access)."
        ].join("\n")
      )
      Assert.deepStrictEqual(h.calls, [{ method: "about", args: [] }])
    }))

  it.effect("reports an OAuth user in read-only mode without a share-with line", () =>
    Effect.gen(function*() {
      const h = yield* harness({
        google: { about: Effect.succeed({}) },
        auth: { credential: Services.oauth, readOnly: true }
      })
      Assert.strictEqual(
        yield* h.call("gdrive_whoami", {}),
        [
          "Credential: OAuth user credential (client client-id.apps.googleusercontent.com)",
          "Drive identity: unknown",
          "Scope: https://www.googleapis.com/auth/drive.readonly (read-only mode)"
        ].join("\n")
      )
    }))

  it.effect("reports the impersonated user for domain-wide delegation, whose files need no sharing", () =>
    Effect.gen(function*() {
      const h = yield* harness({
        google: { about: Effect.succeed({ user: { emailAddress: "ari@scenesystems.io" } }) },
        auth: { credential: Services.delegated }
      })
      Assert.strictEqual(
        yield* h.call("gdrive_whoami", {}),
        [
          "Credential: service account robot@example-project.iam.gserviceaccount.com impersonating ari@scenesystems.io",
          "Drive identity: ari@scenesystems.io",
          "Scope: https://www.googleapis.com/auth/drive"
        ].join("\n")
      )
    }))

  it.effect("reports the service account behind workload identity as the one files must be shared with", () =>
    Effect.gen(function*() {
      const h = yield* harness({
        google: {
          about: Effect.succeed({
            user: { emailAddress: "amp-google-workspace@example-project.iam.gserviceaccount.com" }
          })
        },
        auth: { credential: Services.workloadIdentity }
      })
      Assert.strictEqual(
        yield* h.call("gdrive_whoami", {}),
        [
          "Credential: workload identity for service account amp-google-workspace@example-project.iam.gserviceaccount.com",
          "Drive identity: amp-google-workspace@example-project.iam.gserviceaccount.com",
          "Scope: https://www.googleapis.com/auth/drive",
          "Files must be shared with amp-google-workspace@example-project.iam.gserviceaccount.com (or live in a folder/shared drive it can access)."
        ].join("\n")
      )
    }))

  it.effect("reports delegated workload identity as the person, with no share-with line", () =>
    Effect.gen(function*() {
      const h = yield* harness({
        google: { about: Effect.succeed({ user: { emailAddress: "ari@scenesystems.io", displayName: "Ari" } }) },
        auth: { credential: Services.delegatedWorkloadIdentity, readOnly: true }
      })
      Assert.strictEqual(
        yield* h.call("gdrive_whoami", {}),
        [
          "Credential: workload identity for service account amp-google-workspace@example-project.iam.gserviceaccount.com impersonating ari@scenesystems.io",
          "Drive identity: ari@scenesystems.io (Ari)",
          "Scope: https://www.googleapis.com/auth/drive.readonly (read-only mode)"
        ].join("\n")
      )
    }))

  it.effect("renders the credential error with its hint and makes no Google call when nothing is configured", () =>
    Effect.gen(function*() {
      const h = yield* harness({ auth: { credential: Services.noCredentials } })
      Assert.strictEqual(
        yield* h.call("gdrive_whoami", {}),
        [
          "Error: Google credential error: No Google credentials configured.",
          "Set one of:",
          "  - GOOGLE_WORKLOAD_IDENTITY_PROVIDER + GOOGLE_SERVICE_ACCOUNT_EMAIL (keyless; Amp workspace variables), or",
          "  - GOOGLE_OAUTH_CLIENT_ID + GOOGLE_OAUTH_CLIENT_SECRET + GOOGLE_OAUTH_REFRESH_TOKEN (acts as you; personal secrets), or",
          "  - GOOGLE_SERVICE_ACCOUNT_KEY (service account JSON; Amp workspace secret).",
          "Hint: See the google-workspace skill (reference/setup.md) for setup steps."
        ].join("\n")
      )
      Assert.deepStrictEqual(h.calls, [])
    }))
})

// --- gdrive_search -------------------------------------------------------------------------------

describe("gdrive_search", () => {
  it.effect("searches names and full text by default and lists each match", () =>
    Effect.gen(function*() {
      const h = yield* harness({ google: { listFiles: () => Effect.succeed([doc, sheet]) } })
      Assert.strictEqual(
        yield* h.call("gdrive_search", { query: "roadmap" }),
        [
          "2 result(s):",
          "- **Vision** (Google Doc)",
          `  id: ${DOC_ID}`,
          "  modified: 2026-09-01T10:00:00Z by ari@scenesystems.io",
          `  link: ${DOC_LINK}`,
          "- **Roadmap** (Google Sheet)",
          `  id: ${SHEET_ID}`,
          `  link: ${SHEET_LINK}`
        ].join("\n")
      )
      Assert.deepStrictEqual(h.calls, [{
        method: "listFiles",
        args: [{
          q: "trashed = false and (name contains 'roadmap' or fullText contains 'roadmap')",
          pageSize: undefined
        }]
      }])
    }))

  it.effect("applies type, folder (from a URL), nameOnly, and limit to the Drive query", () =>
    Effect.gen(function*() {
      const h = yield* harness({ google: { listFiles: () => Effect.succeed([sheet]) } })
      yield* h.call("gdrive_search", {
        query: "Ari's plan",
        type: "sheets",
        folder: "https://drive.google.com/drive/folders/1Folder0000000000000?usp=sharing",
        nameOnly: true,
        limit: 5
      })
      Assert.deepStrictEqual(h.calls, [{
        method: "listFiles",
        args: [{
          q: "trashed = false and name contains 'Ari\\'s plan' and (mimeType = 'application/vnd.google-apps.spreadsheet') and '1Folder0000000000000' in parents",
          pageSize: 5
        }]
      }])
    }))

  it.effect("lists everything when no query is given", () =>
    Effect.gen(function*() {
      const h = yield* harness({ google: { listFiles: () => Effect.succeed([folder]) } })
      Assert.strictEqual(
        yield* h.call("gdrive_search", { type: "folders" }),
        `1 result(s):\n- **Specs** (Folder)\n  id: ${folder.id}`
      )
      Assert.deepStrictEqual(h.calls, [{
        method: "listFiles",
        args: [{
          q: "trashed = false and (mimeType = 'application/vnd.google-apps.folder')",
          pageSize: undefined
        }]
      }])
    }))

  it.effect("explains an empty result and points at sharing", () =>
    Effect.gen(function*() {
      const h = yield* harness({ google: { listFiles: () => Effect.succeed([]) } })
      Assert.strictEqual(
        yield* h.call("gdrive_search", { query: "missing" }),
        "No files found for query: trashed = false and (name contains 'missing' or fullText contains 'missing')\nIf the file exists, make sure it is shared with the plugin identity (run gdrive_whoami)."
      )
    }))

  it.effect("rejects an invalid folder reference at the schema boundary without calling Google", () =>
    Effect.gen(function*() {
      const h = yield* harness()
      Assert.strictEqual(
        yield* h.call("gdrive_search", { folder: "nope" }),
        "SchemaError: \"nope\" is not a Google Drive file ID or docs.google.com/drive.google.com URL.\n  at [\"folder\"]"
      )
      Assert.deepStrictEqual(h.calls, [])
    }))

  it.effect("rejects an unknown type literal", () =>
    Effect.gen(function*() {
      const h = yield* harness()
      Assert.strictEqual(
        yield* h.call("gdrive_search", { type: "pdfs" }),
        "SchemaError: Expected \"any\" | \"docs\" | \"sheets\" | \"slides\" | \"folders\"\n  at [\"type\"]"
      )
      Assert.deepStrictEqual(h.calls, [])
    }))
})

// --- gdrive_file_info and error explanation ------------------------------------------------------

describe("gdrive_file_info", () => {
  it.effect("renders the metadata header for a Doc", () =>
    Effect.gen(function*() {
      const h = yield* harness({ google: { getFile: () => Effect.succeed(doc) } })
      Assert.strictEqual(yield* h.call("gdrive_file_info", { file: DOC_ID }), docHeader)
      Assert.deepStrictEqual(h.calls, [{ method: "getFile", args: [DOC_ID] }])
    }))

  it.effect("accepts a URL and appends the tab list for a Sheet", () =>
    Effect.gen(function*() {
      const h = yield* harness({
        google: { getFile: () => Effect.succeed(sheet), getSpreadsheet: () => Effect.succeed(spreadsheet) }
      })
      Assert.strictEqual(
        yield* h.call("gdrive_file_info", { file: `${SHEET_LINK}#gid=734` }),
        `${sheetHeader}\n\n## Tabs\n- Backlog (gid 0) — 100 rows × 6 cols\n- Q4 Plan (gid 734)`
      )
      Assert.deepStrictEqual(h.calls, [
        { method: "getFile", args: [SHEET_ID] },
        { method: "getSpreadsheet", args: [SHEET_ID] }
      ])
    }))

  it.effect("requires the file argument", () =>
    Effect.gen(function*() {
      const h = yield* harness()
      Assert.strictEqual(yield* h.call("gdrive_file_info", {}), "SchemaError: Missing key\n  at [\"file\"]")
    }))
})

describe("Google API errors are explained to the agent", () => {
  const notFound = new GoogleApiError({ message: `File not found: ${DOC_ID}.`, status: 404, reason: "notFound" })
  const forbidden = new GoogleApiError({
    message: "The caller does not have permission",
    status: 403,
    reason: "forbidden"
  })

  it.effect("404: names the identity the file must be shared with", () =>
    Effect.gen(function*() {
      const h = yield* harness({ google: { getFile: fail(notFound) } })
      Assert.strictEqual(
        yield* h.call("gdrive_file_info", { file: DOC_ID }),
        `Error: Google API error 404 (notFound): File not found: ${DOC_ID}.\nHint: The file does not exist or is not shared with robot@example-project.iam.gserviceaccount.com. Drive returns 404 for files the identity cannot see.`
      )
    }))

  it.effect("404 under delegation: the impersonated user is the identity", () =>
    Effect.gen(function*() {
      const h = yield* harness({ google: { getFile: fail(notFound) }, auth: { credential: Services.delegated } })
      Assert.strictEqual(
        yield* h.call("gdrive_file_info", { file: DOC_ID }),
        `Error: Google API error 404 (notFound): File not found: ${DOC_ID}.\nHint: The file does not exist or is not shared with ari@scenesystems.io. Drive returns 404 for files the identity cannot see.`
      )
    }))

  it.effect("403 for an OAuth user: asks for permission on the file", () =>
    Effect.gen(function*() {
      const h = yield* harness({ google: { getFile: fail(forbidden) }, auth: { credential: Services.oauth } })
      Assert.strictEqual(
        yield* h.call("gdrive_file_info", { file: DOC_ID }),
        "Error: Google API error 403 (forbidden): The caller does not have permission\nHint: the OAuth user lacks permission. Share the file (or its folder) with that identity, or check that the Drive/Docs/Sheets APIs are enabled in the Google Cloud project."
      )
    }))

  it.effect("403 when the credential itself cannot be resolved: falls back to gdrive_whoami", () =>
    Effect.gen(function*() {
      const h = yield* harness({ google: { getFile: fail(forbidden) }, auth: { credential: Services.noCredentials } })
      Assert.strictEqual(
        yield* h.call("gdrive_file_info", { file: DOC_ID }),
        "Error: Google API error 403 (forbidden): The caller does not have permission\nHint: the plugin identity (run gdrive_whoami) lacks permission. Share the file (or its folder) with that identity, or check that the Drive/Docs/Sheets APIs are enabled in the Google Cloud project."
      )
    }))

  it.effect("accessNotConfigured: tells the user to enable the APIs", () =>
    Effect.gen(function*() {
      const error = new GoogleApiError({
        message: "Access Not Configured.",
        status: 403,
        reason: "accessNotConfigured"
      })
      const h = yield* harness({ google: { getFile: fail(error) } })
      Assert.strictEqual(
        yield* h.call("gdrive_file_info", { file: DOC_ID }),
        `Error: Google API error 403 (accessNotConfigured): Access Not Configured.\nHint: ${ENABLE_APIS_HINT}`
      )
    }))

  it.effect("a 'has not been used in project' message is recognised even under another reason", () =>
    Effect.gen(function*() {
      const error = new GoogleApiError({
        message: "Google Docs API has not been used in project 123 before or it is disabled.",
        status: 403,
        reason: "SERVICE_DISABLED"
      })
      const h = yield* harness({ google: { getFile: fail(error) } })
      Assert.strictEqual(
        yield* h.call("gdrive_file_info", { file: DOC_ID }),
        `Error: Google API error 403 (SERVICE_DISABLED): Google Docs API has not been used in project 123 before or it is disabled.\nHint: ${ENABLE_APIS_HINT}`
      )
    }))

  it.effect("other statuses are reported without a hint, omitting a missing reason", () =>
    Effect.gen(function*() {
      const h = yield* harness({
        google: { getFile: fail(new GoogleApiError({ message: "Backend Error", status: 500 })) }
      })
      Assert.strictEqual(
        yield* h.call("gdrive_file_info", { file: DOC_ID }),
        "Error: Google API error 500: Backend Error"
      )
    }))

  it.effect("transport failures carry status 0 and the HttpClientError tag", () =>
    Effect.gen(function*() {
      const h = yield* harness({
        google: { getFile: fail(new GoogleApiError({ message: "fetch failed", status: 0, reason: "RequestError" })) }
      })
      Assert.strictEqual(
        yield* h.call("gdrive_file_info", { file: DOC_ID }),
        "Error: Google API error 0 (RequestError): fetch failed"
      )
    }))

  it.effect("a defect is reported with its cause instead of rejecting the tool call", () =>
    Effect.gen(function*() {
      const h = yield* harness({ google: { getFile: () => Effect.die(new Boom({ message: "kaboom" })) } })
      const out = yield* h.call("gdrive_file_info", { file: DOC_ID })
      Assert.assertTrue(
        out.startsWith("Tool failed unexpectedly:\nBoom: kaboom\n    at "),
        `unexpected rendering:\n${out}`
      )
    }))
})

// --- gdocs_read -----------------------------------------------------------------------------------

describe("gdocs_read", () => {
  it.effect("exports a Doc as Markdown under its header", () =>
    Effect.gen(function*() {
      const h = yield* harness({
        google: { getFile: () => Effect.succeed(doc), exportFile: () => Effect.succeed("# Vision\n\nWe ship.") }
      })
      Assert.strictEqual(yield* h.call("gdocs_read", { file: DOC_LINK }), `${docHeader}\n\n---\n\n# Vision\n\nWe ship.`)
      Assert.deepStrictEqual(h.calls, [
        { method: "getFile", args: [DOC_ID] },
        { method: "exportFile", args: [DOC_ID, "text/markdown"] }
      ])
    }))

  it.effect("format=text exports plain text", () =>
    Effect.gen(function*() {
      const h = yield* harness({
        google: { getFile: () => Effect.succeed(doc), exportFile: () => Effect.succeed("We ship.") }
      })
      yield* h.call("gdocs_read", { file: DOC_ID, format: "text" })
      Assert.deepStrictEqual(h.calls[1], { method: "exportFile", args: [DOC_ID, "text/plain"] })
    }))

  it.effect("Slides are exported as plain text regardless of format", () =>
    Effect.gen(function*() {
      const h = yield* harness({
        google: { getFile: () => Effect.succeed(slides), exportFile: () => Effect.succeed("Slide 1") }
      })
      Assert.strictEqual(
        yield* h.call("gdocs_read", { file: slides.id, format: "markdown" }),
        `# Pitch\n- Type: Google Slides\n- ID: ${slides.id}\n\n---\n\nSlide 1`
      )
      Assert.deepStrictEqual(h.calls[1], { method: "exportFile", args: [slides.id, "text/plain"] })
    }))

  it.effect("a Sheet returns its first tab as a table and points at gsheets_read", () =>
    Effect.gen(function*() {
      const h = yield* harness({
        google: {
          getFile: () => Effect.succeed(sheet),
          getSpreadsheet: () => Effect.succeed(spreadsheet),
          getValues: () => Effect.succeed([["A", "B"], ["1", "2"]])
        }
      })
      Assert.strictEqual(
        yield* h.call("gdocs_read", { file: SHEET_ID }),
        `${sheetHeader}\n\n---\n\n_First tab "Backlog" of 2; use gsheets_read for other tabs or ranges._\n\n| A | B |\n| --- | --- |\n| 1 | 2 |`
      )
      Assert.deepStrictEqual(h.calls, [
        { method: "getFile", args: [SHEET_ID] },
        { method: "getSpreadsheet", args: [SHEET_ID] },
        { method: "getValues", args: [SHEET_ID, "Backlog"] }
      ])
    }))

  it.effect("a Sheet whose first tab needs quoting is read with a quoted range and capped at 200 rows", () =>
    Effect.gen(function*() {
      const meta = new Model.Spreadsheet({
        spreadsheetId: SHEET_ID,
        properties: { title: "Roadmap" },
        sheets: [{ properties: { sheetId: 0, title: "Q4 Plan" } }]
      })
      const many: Model.Rows = Arr.makeBy(250, (i) => [i])
      const h = yield* harness({
        google: {
          getFile: () => Effect.succeed(sheet),
          getSpreadsheet: () => Effect.succeed(meta),
          getValues: () => Effect.succeed(many)
        }
      })
      const out = yield* h.call("gdocs_read", { file: SHEET_ID })
      Assert.deepStrictEqual(h.calls[2], { method: "getValues", args: [SHEET_ID, "'Q4 Plan'"] })
      // header row "0", separator, then rows 1..199: 201 table lines after the note.
      const content = Arr.get(out.split("\n\n---\n\n"), 1)
      Assert.assertTrue(Option.isSome(content))
      const table = Arr.get(content.value.split("\n\n"), 1)
      Assert.assertTrue(Option.isSome(table))
      Assert.strictEqual(table.value.split("\n").length, 201)
      Assert.strictEqual(table.value.split("\n").at(-1), "| 199 |")
    }))

  it.effect("a Sheet with no tabs says so", () =>
    Effect.gen(function*() {
      const h = yield* harness({
        google: { getFile: () => Effect.succeed(sheet), getSpreadsheet: () => Effect.succeed(emptySpreadsheet) }
      })
      Assert.strictEqual(
        yield* h.call("gdocs_read", { file: SHEET_ID }),
        `${sheetHeader}\n\n---\n\n_(spreadsheet has no tabs)_`
      )
    }))

  it.effect("text-like files are downloaded rather than exported", () =>
    Effect.gen(function*() {
      const h = yield* harness({
        google: { getFile: () => Effect.succeed(csv), downloadFile: () => Effect.succeed("a,b\n1,2") }
      })
      Assert.strictEqual(
        yield* h.call("gdocs_read", { file: csv.id }),
        `# export.csv\n- Type: text/csv\n- ID: ${csv.id}\n\n---\n\na,b\n1,2`
      )
      Assert.deepStrictEqual(h.calls[1], { method: "downloadFile", args: [csv.id] })
    }))

  it.effect("a folder is refused with a pointer to gdrive_search", () =>
    Effect.gen(function*() {
      const h = yield* harness({ google: { getFile: () => Effect.succeed(folder) } })
      Assert.strictEqual(
        yield* h.call("gdocs_read", { file: folder.id }),
        `Error: Specs is a folder.\nHint: Use gdrive_search with folder=${folder.id} to list its contents.`
      )
      Assert.deepStrictEqual(h.calls, [{ method: "getFile", args: [folder.id] }])
    }))

  it.effect("binary files are refused without a download", () =>
    Effect.gen(function*() {
      const h = yield* harness({ google: { getFile: () => Effect.succeed(png) } })
      Assert.strictEqual(
        yield* h.call("gdocs_read", { file: png.id }),
        "Error: Cannot read image/png files as text (photo.png)."
      )
      Assert.deepStrictEqual(h.calls, [{ method: "getFile", args: [png.id] }])
    }))

  it.effect("pages long documents and tells the agent how to continue", () =>
    Effect.gen(function*() {
      const content = "x".repeat(2500)
      const h = yield* harness({
        google: { getFile: () => Effect.succeed(doc), exportFile: () => Effect.succeed(content) }
      })
      Assert.strictEqual(
        yield* h.call("gdocs_read", { file: DOC_ID, maxChars: 1000 }),
        `${docHeader}\n\n---\n\n${
          "x".repeat(1000)
        }\n\n---\n_truncated: showing chars 0-1000 of 2500. Call gdocs_read again with startChar=1000 for more._`
      )
      Assert.strictEqual(
        yield* h.call("gdocs_read", { file: DOC_ID, maxChars: 1000, startChar: 1000 }),
        `${docHeader}\n\n---\n\n${
          "x".repeat(1000)
        }\n\n---\n_truncated: showing chars 1000-2000 of 2500. Call gdocs_read again with startChar=2000 for more._`
      )
      Assert.strictEqual(
        yield* h.call("gdocs_read", { file: DOC_ID, maxChars: 1000, startChar: 2000 }),
        `${docHeader}\n\n---\n\n${"x".repeat(500)}`
      )
    }))
})

// --- gsheets_read ---------------------------------------------------------------------------------

describe("gsheets_read", () => {
  const google = (values: Model.Rows = rows): Services.Stubs => ({
    getSpreadsheet: () => Effect.succeed(spreadsheet),
    getValues: () => Effect.succeed(values)
  })
  const header = [
    "# Roadmap",
    `- ID: ${SHEET_ID}`,
    `- Link: ${SHEET_LINK}`,
    "- Tabs: Backlog (gid 0), Q4 Plan (gid 734)"
  ].join("\n")
  const table = "| Item | Owner |\n| --- | --- |\n| Auth | Ari |\n| Billing | Sam |"

  it.effect("with no range reads the first tab as a Markdown table", () =>
    Effect.gen(function*() {
      const h = yield* harness({ google: google() })
      Assert.strictEqual(
        yield* h.call("gsheets_read", { file: SHEET_ID }),
        `${header}\n- Range: Backlog — 3 row(s)\n\n${table}`
      )
      Assert.deepStrictEqual(h.calls, [
        { method: "getSpreadsheet", args: [SHEET_ID] },
        { method: "getValues", args: [SHEET_ID, "Backlog"] }
      ])
    }))

  it.effect("the #gid= in a URL selects the tab, quoted for A1 notation", () =>
    Effect.gen(function*() {
      const h = yield* harness({ google: google() })
      const out = yield* h.call("gsheets_read", { file: `${SHEET_LINK}#gid=734` })
      Assert.deepStrictEqual(h.calls[1], { method: "getValues", args: [SHEET_ID, "'Q4 Plan'"] })
      Assert.strictEqual(out.split("\n")[4], "- Range: 'Q4 Plan' — 3 row(s)")
    }))

  it.effect("an unknown gid falls back to the first tab", () =>
    Effect.gen(function*() {
      const h = yield* harness({ google: google() })
      yield* h.call("gsheets_read", { file: `${SHEET_LINK}#gid=999` })
      Assert.deepStrictEqual(h.calls[1], { method: "getValues", args: [SHEET_ID, "Backlog"] })
    }))

  it.effect.each([
    { range: "Q4 Plan", sent: "'Q4 Plan'", why: "a bare tab title is quoted" },
    { range: "  Backlog  ", sent: "Backlog", why: "whitespace around a tab title is trimmed" },
    { range: "Backlog!A1:B2", sent: "Backlog!A1:B2", why: "A1 notation is passed through" },
    { range: "Nope", sent: "Nope", why: "an unknown name is passed through for Sheets to reject" }
  ])("range $range → $sent ($why)", ({ range, sent }) =>
    Effect.gen(function*() {
      const h = yield* harness({ google: google() })
      yield* h.call("gsheets_read", { file: SHEET_ID, range })
      Assert.deepStrictEqual(h.calls[1], { method: "getValues", args: [SHEET_ID, sent] })
    }))

  it.effect("a blank range means no range", () =>
    Effect.gen(function*() {
      const h = yield* harness({ google: google() })
      yield* h.call("gsheets_read", { file: SHEET_ID, range: "   " })
      Assert.deepStrictEqual(h.calls[1], { method: "getValues", args: [SHEET_ID, "Backlog"] })
    }))

  it.effect("format=csv and format=json render the same rows differently", () =>
    Effect.gen(function*() {
      const h = yield* harness({ google: google() })
      Assert.strictEqual(
        yield* h.call("gsheets_read", { file: SHEET_ID, format: "csv" }),
        `${header}\n- Range: Backlog — 3 row(s)\n\nItem,Owner\nAuth,Ari\nBilling,Sam`
      )
      Assert.strictEqual(
        yield* h.call("gsheets_read", { file: SHEET_ID, format: "json" }),
        `${header}\n- Range: Backlog — 3 row(s)\n\n[["Item","Owner"],["Auth","Ari"],["Billing","Sam"]]`
      )
    }))

  it.effect("headerRow=false labels columns by letter", () =>
    Effect.gen(function*() {
      const h = yield* harness({ google: google() })
      Assert.strictEqual(
        yield* h.call("gsheets_read", { file: SHEET_ID, headerRow: false }),
        `${header}\n- Range: Backlog — 3 row(s)\n\n| A | B |\n| --- | --- |\n| Item | Owner |\n| Auth | Ari |\n| Billing | Sam |`
      )
    }))

  it.effect("maxRows truncates and says so; values below 1 are treated as 1", () =>
    Effect.gen(function*() {
      const h = yield* harness({ google: google() })
      Assert.strictEqual(
        yield* h.call("gsheets_read", { file: SHEET_ID, maxRows: 2 }),
        `${header}\n- Range: Backlog — 3 row(s), showing first 2\n\n| Item | Owner |\n| --- | --- |\n| Auth | Ari |`
      )
      Assert.strictEqual(
        yield* h.call("gsheets_read", { file: SHEET_ID, maxRows: 0 }),
        `${header}\n- Range: Backlog — 3 row(s), showing first 1\n\n| Item | Owner |\n| --- | --- |`
      )
    }))

  it.effect("an empty range renders the placeholder", () =>
    Effect.gen(function*() {
      const h = yield* harness({ google: google([]) })
      Assert.strictEqual(
        yield* h.call("gsheets_read", { file: SHEET_ID }),
        `${header}\n- Range: Backlog — 0 row(s)\n\n_(empty range)_`
      )
    }))

  it.effect("a spreadsheet without tabs fails before reading values", () =>
    Effect.gen(function*() {
      const h = yield* harness({ google: { getSpreadsheet: () => Effect.succeed(emptySpreadsheet) } })
      Assert.strictEqual(yield* h.call("gsheets_read", { file: SHEET_ID }), "Error: Spreadsheet has no tabs.")
      Assert.deepStrictEqual(h.calls, [{ method: "getSpreadsheet", args: [SHEET_ID] }])
    }))
})

// --- gdrive_comments ------------------------------------------------------------------------------

describe("gdrive_comments", () => {
  const comment = new Model.DriveComment({
    id: "c1",
    author: { displayName: "Ari", emailAddress: "ari@scenesystems.io" },
    content: "Tighten this.",
    createdTime: "2026-09-01T00:00:00Z"
  })

  it.effect("lists open comments under the file header", () =>
    Effect.gen(function*() {
      const h = yield* harness({
        google: { getFile: () => Effect.succeed(doc), listComments: () => Effect.succeed([comment]) }
      })
      Assert.strictEqual(
        yield* h.call("gdrive_comments", { file: DOC_LINK }),
        `${docHeader}\n\n## Comments (1)\n\n### Ari — 2026-09-01T00:00:00Z\nTighten this.\n  _comment id: c1_`
      )
      Assert.deepStrictEqual(
        [...h.calls].sort((a, b) => a.method.localeCompare(b.method)),
        [
          { method: "getFile", args: [DOC_ID] },
          { method: "listComments", args: [DOC_ID, { includeResolved: false }] }
        ]
      )
    }))

  it.effect("includeResolved is forwarded and an empty list has a placeholder", () =>
    Effect.gen(function*() {
      const h = yield* harness({
        google: { getFile: () => Effect.succeed(doc), listComments: () => Effect.succeed([]) }
      })
      Assert.strictEqual(
        yield* h.call("gdrive_comments", { file: DOC_ID, includeResolved: true }),
        `${docHeader}\n\n## Comments (0)\n\n_(no comments)_`
      )
      Assert.deepStrictEqual(
        h.calls.find((c) => c.method === "listComments"),
        { method: "listComments", args: [DOC_ID, { includeResolved: true }] }
      )
    }))
})

// --- write tools ----------------------------------------------------------------------------------

describe("gsheets_write", () => {
  const values: Model.Rows = [["a", 1], ["b", 2]]

  it.effect("mode=update (the default) overwrites the range and reports the cell count", () =>
    Effect.gen(function*() {
      const h = yield* harness({
        google: {
          updateValues: () =>
            Effect.succeed({ updatedRange: "Log!A1:B2", updatedRows: 2, updatedColumns: 2, updatedCells: 4 })
        }
      })
      Assert.strictEqual(
        yield* h.call("gsheets_write", { file: SHEET_ID, range: "Log!A1", values }),
        "Updated 4 cell(s) in Log!A1:B2"
      )
      Assert.deepStrictEqual(h.calls, [{ method: "updateValues", args: [SHEET_ID, "Log!A1", values] }])
    }))

  it.effect("mode=append reports the rows and the range Sheets chose", () =>
    Effect.gen(function*() {
      const h = yield* harness({
        google: { appendValues: () => Effect.succeed({ updates: { updatedRange: "Log!A5:B6", updatedRows: 2 } }) }
      })
      Assert.strictEqual(
        yield* h.call("gsheets_write", { file: SHEET_ID, range: "Log", values, mode: "append" }),
        "Appended 2 row(s) → Log!A5:B6"
      )
      Assert.deepStrictEqual(h.calls, [{ method: "appendValues", args: [SHEET_ID, "Log", values] }])
    }))

  it.effect("falls back to the request when Sheets omits the summary fields", () =>
    Effect.gen(function*() {
      const h = yield* harness({
        google: { updateValues: () => Effect.succeed({}), appendValues: () => Effect.succeed({}) }
      })
      Assert.strictEqual(
        yield* h.call("gsheets_write", { file: SHEET_ID, range: "Log!A1", values }),
        "Updated ? cell(s) in Log!A1"
      )
      Assert.strictEqual(
        yield* h.call("gsheets_write", { file: SHEET_ID, range: "Log", values, mode: "append" }),
        "Appended 2 row(s) → Log"
      )
    }))

  it.effect("rejects cells that are not string, number, boolean, or null", () =>
    Effect.gen(function*() {
      const h = yield* harness()
      Assert.strictEqual(
        yield* h.call("gsheets_write", { file: SHEET_ID, range: "Log!A1", values: [[{ nested: true }]] }),
        "SchemaError: Expected string | number | boolean | null\n  at [\"values\"][0][0]"
      )
      Assert.deepStrictEqual(h.calls, [])
    }))

  it.effect("is refused in read-only mode before any Google call", () =>
    Effect.gen(function*() {
      const h = yield* harness({ auth: { readOnly: true } })
      Assert.strictEqual(yield* h.call("gsheets_write", { file: SHEET_ID, range: "Log!A1", values }), READ_ONLY_REFUSAL)
      Assert.deepStrictEqual(h.calls, [])
    }))
})

describe("gdocs_append", () => {
  it.effect("inserts a newline plus the text and reports the count and link", () =>
    Effect.gen(function*() {
      const h = yield* harness({
        google: { getFile: () => Effect.succeed(doc), appendDocumentText: () => Effect.void }
      })
      Assert.strictEqual(
        yield* h.call("gdocs_append", { file: DOC_ID, text: "Decision: ship it." }),
        `Appended 18 characters to "Vision" (${DOC_LINK}).`
      )
      Assert.deepStrictEqual(h.calls, [
        { method: "getFile", args: [DOC_ID] },
        { method: "appendDocumentText", args: [DOC_ID, "\nDecision: ship it."] }
      ])
    }))

  it.effect("falls back to the id when the file has no link", () =>
    Effect.gen(function*() {
      const bare = new Model.DriveFile({ id: DOC_ID, name: "Vision", mimeType: Model.MIME.doc })
      const h = yield* harness({
        google: { getFile: () => Effect.succeed(bare), appendDocumentText: () => Effect.void }
      })
      Assert.strictEqual(
        yield* h.call("gdocs_append", { file: DOC_ID, text: "x" }),
        `Appended 1 characters to "Vision" (${DOC_ID}).`
      )
    }))

  it.effect("refuses non-Docs without writing", () =>
    Effect.gen(function*() {
      const h = yield* harness({ google: { getFile: () => Effect.succeed(sheet) } })
      Assert.strictEqual(
        yield* h.call("gdocs_append", { file: SHEET_ID, text: "x" }),
        "Error: Roadmap is a Google Sheet, not a Google Doc."
      )
      Assert.deepStrictEqual(h.calls, [{ method: "getFile", args: [SHEET_ID] }])
    }))

  it.effect("is refused in read-only mode before even fetching metadata", () =>
    Effect.gen(function*() {
      const h = yield* harness({ auth: { readOnly: true } })
      Assert.strictEqual(yield* h.call("gdocs_append", { file: DOC_ID, text: "x" }), READ_ONLY_REFUSAL)
      Assert.deepStrictEqual(h.calls, [])
    }))
})

describe("gdrive_comment_add", () => {
  it.effect("creates the comment and reports its id and author", () =>
    Effect.gen(function*() {
      const created = new Model.DriveComment({
        id: "c9",
        author: { emailAddress: "robot@example-project.iam.gserviceaccount.com" }
      })
      const h = yield* harness({ google: { createComment: () => Effect.succeed(created) } })
      Assert.strictEqual(
        yield* h.call("gdrive_comment_add", { file: DOC_LINK, content: "Please expand." }),
        "Added comment c9 as robot@example-project.iam.gserviceaccount.com."
      )
      Assert.deepStrictEqual(h.calls, [{ method: "createComment", args: [DOC_ID, "Please expand."] }])
    }))

  it.effect.each([
    { author: { displayName: "Robot" }, rendered: "Robot", why: "display name when the email is hidden" },
    { author: undefined, rendered: "plugin identity", why: "generic label when Drive returns no author" }
  ])("author → $rendered ($why)", ({ author, rendered }) =>
    Effect.gen(function*() {
      const created = new Model.DriveComment(author === undefined ? { id: "c9" } : { id: "c9", author })
      const h = yield* harness({ google: { createComment: () => Effect.succeed(created) } })
      Assert.strictEqual(
        yield* h.call("gdrive_comment_add", { file: DOC_ID, content: "x" }),
        `Added comment c9 as ${rendered}.`
      )
    }))

  it.effect("is refused in read-only mode", () =>
    Effect.gen(function*() {
      const h = yield* harness({ auth: { readOnly: true } })
      Assert.strictEqual(yield* h.call("gdrive_comment_add", { file: DOC_ID, content: "x" }), READ_ONLY_REFUSAL)
      Assert.deepStrictEqual(h.calls, [])
    }))
})

// --- the LLM-facing contract ----------------------------------------------------------------------

describe("tool definitions", () => {
  const skill = readFileSync(fileURLToPath(new URL("../skills/google-workspace/SKILL.md", import.meta.url)), "utf8")

  it("registers the nine tools in documented order with their display metadata", () => {
    const amp = PluginApi.make()
    const runtime = Runtime.make(amp.api, Layer.mergeAll(Services.google({}).layer, Services.auth()))
    Tool.registerAll(amp.api, runtime, Tools.all)
    Assert.deepStrictEqual(
      amp.tools.map((t) => ({ name: t.name, title: t.title, transcriptGroup: t.transcriptGroup })),
      [
        { name: "gdrive_whoami", title: "Check Google credentials", transcriptGroup: undefined },
        {
          name: "gdrive_search",
          title: "Search Google Drive",
          transcriptGroup: { active: "Searching Google Drive", complete: "Searched Google Drive" }
        },
        { name: "gdrive_file_info", title: "Google Drive file info", transcriptGroup: undefined },
        {
          name: "gdocs_read",
          title: "Read Google Doc",
          transcriptGroup: { active: "Reading Google Docs", complete: "Read Google Docs" }
        },
        {
          name: "gsheets_read",
          title: "Read Google Sheet",
          transcriptGroup: { active: "Reading Google Sheets", complete: "Read Google Sheets" }
        },
        { name: "gdrive_comments", title: "List Google Drive comments", transcriptGroup: undefined },
        { name: "gsheets_write", title: "Write Google Sheet", transcriptGroup: undefined },
        { name: "gdocs_append", title: "Append to Google Doc", transcriptGroup: undefined },
        { name: "gdrive_comment_add", title: "Add Google Drive comment", transcriptGroup: undefined }
      ]
    )
  })

  it("the skill's builtin-tools list is exactly the registered tool names, in order", () => {
    const frontmatter = Arr.get(skill.split("---"), 1)
    Assert.assertTrue(Option.isSome(frontmatter))
    const toolsSection = Arr.get(frontmatter.value.split("builtin-tools:"), 1)
    Assert.assertTrue(Option.isSome(toolsSection))
    const listed = toolsSection.value.split("\n").filter((line) => line.startsWith("  - "))
      .map((line) => line.slice(4).trim())
    Assert.deepStrictEqual(listed, Tools.all.map((t) => t.name))
  })

  it("every tool name is mentioned in the skill body", () => {
    const body = skill.split("---").slice(2).join("---")
    Arr.forEach(Tools.all, (tool) => Assert.assertInclude(body, `\`${tool.name}\``))
  })

  it("names, descriptions, and input schemas match the committed contract", () => {
    // What the model sees. Changing it changes agent behaviour, so the diff must be reviewed deliberately.
    const contract = Tools.all.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: Tool.toInputSchema(tool.input)
    }))
    const committed = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown))(
      readFileSync(fileURLToPath(new URL("__snapshots__/tool-contract.json", import.meta.url)), "utf8")
    )
    Assert.strictEqual(toJson(contract), toJson(committed))
  })
})
