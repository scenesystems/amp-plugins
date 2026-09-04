import type { PluginToolContext } from "@ampcode/plugin"
import { Tool } from "@scenesystems/amp-plugin-core"
import { afterAll, describe, expect, test } from "@scenesystems/amp-plugin-testing"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as ManagedRuntime from "effect/ManagedRuntime"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Credential from "../src/Credential.ts"
import { Google, GoogleApiError } from "../src/Google.ts"
import { GoogleAuth } from "../src/GoogleAuth.ts"
import * as Model from "../src/Model.ts"
import * as Tools from "../src/Tools.ts"

/**
 * Runs tools exactly as Amp would (through `Tool.toPluginTool`) against scripted `Google` and
 * `GoogleAuth` services, so decoding, error rendering, and output formatting are covered end to end.
 */
const ctx = {} as PluginToolContext

const serviceAccount: Credential.ServiceAccount = {
  _tag: "ServiceAccount",
  clientEmail: "sa@p.iam.gserviceaccount.com",
  privateKey: Redacted.make("pem"),
  tokenUri: "https://oauth2.googleapis.com/token",
  subject: Option.none()
}

const authLayer = (readOnly: boolean) =>
  Layer.succeed(GoogleAuth)({
    credential: Effect.succeed(serviceAccount),
    scope: Effect.succeed(readOnly ? Credential.SCOPE_READ_ONLY : Credential.SCOPE_FULL),
    readOnly: Effect.succeed(readOnly),
    accessToken: Effect.succeed(Redacted.make("token")),
    invalidate: Effect.void
  })

const unexpected = (name: string) => () => Effect.die(`unexpected call: ${name}`)

const doc = new Model.DriveFile({
  id: "1DocVision0000000000",
  name: "Vision",
  mimeType: Model.MIME.doc,
  webViewLink: "https://docs.google.com/document/d/1DocVision0000000000/edit",
  modifiedTime: "2026-09-01T00:00:00Z"
})

const sheet = new Model.DriveFile({ id: "1SheetBacklog000000", name: "Backlog", mimeType: Model.MIME.sheet })
const folder = new Model.DriveFile({ id: "1FolderSpecs0000000", name: "Specs", mimeType: Model.MIME.folder })

const files: Record<string, Model.DriveFile> = Object.fromEntries([doc, sheet, folder].map((f) => [f.id, f]))

const notFound = (fileId: string) =>
  new GoogleApiError({ message: `File not found: ${fileId}.`, status: 404, reason: "notFound" })

const googleLayer = Layer.succeed(Google)({
  about: Effect.succeed({ user: { emailAddress: "sa@p.iam.gserviceaccount.com", displayName: "Amp Bot" } }),
  getFile: (fileId) => files[fileId] === undefined ? Effect.fail(notFound(fileId)) : Effect.succeed(files[fileId]),
  listFiles: ({ q }) => Effect.succeed(q.includes("'Vision'") || q.includes("Vision") ? [doc] : []),
  exportFile: (fileId, mimeType) => Effect.succeed(`# ${fileId} as ${mimeType}\n\n${"body ".repeat(400)}`),
  downloadFile: unexpected("downloadFile"),
  listComments: () => Effect.succeed([new Model.DriveComment({ id: "c1", content: "Clarify scope" })]),
  createComment: (_fileId, content) => Effect.succeed(new Model.DriveComment({ id: "c9", content })),
  getSpreadsheet: () =>
    Effect.succeed(
      new Model.Spreadsheet({
        spreadsheetId: "1SheetBacklog000000",
        properties: { title: "Backlog" },
        sheets: [
          { properties: { sheetId: 0, title: "Items", gridProperties: { rowCount: 3, columnCount: 2 } } },
          { properties: { sheetId: 77, title: "Q3 plan" } }
        ]
      })
    ),
  getValues: (_id, range) => Effect.succeed([["Task", "Owner"], ["Ship plugin", "Ari"], [`range=${range}`, null]]),
  updateValues: (_id, range) => Effect.succeed({ updatedRange: range, updatedCells: 4 }),
  appendValues: (_id, range) => Effect.succeed({ updates: { updatedRange: `${range}:B2`, updatedRows: 1 } }),
  appendDocumentText: () => Effect.void
})

const runtimeFor = (readOnly: boolean) => ManagedRuntime.make(Layer.mergeAll(googleLayer, authLayer(readOnly)))

const runtime = runtimeFor(false)
const readOnlyRuntime = runtimeFor(true)
afterAll(() => Promise.all([runtime.dispose(), readOnlyRuntime.dispose()]))

const call = (tool: Tool.Tool<any, any, Tools.Services>, input: Record<string, unknown>, rt = runtime) =>
  Tool.toPluginTool(rt)(tool).execute(input, ctx) as Promise<string>

describe("tool definitions", () => {
  test("every tool has a unique name, a description, and described parameters", () => {
    const names = Tools.all.map((tool) => tool.name)
    expect(new Set(names).size).toBe(names.length)
    for (const tool of Tools.all) {
      expect(tool.description.length).toBeGreaterThan(40)
      const schema = Tool.toInputSchema(tool.input)
      expect(schema.type).toBe("object")
      for (const [name, property] of Object.entries(schema.properties ?? {})) {
        expect(property, `${tool.name}.${name}`).toHaveProperty("description")
      }
    }
  })

  test("matches the tools the bundled skill declares", async () => {
    const skill = await Bun.file(new URL("../skills/google-workspace/SKILL.md", import.meta.url)).text()
    const declared = [...skill.matchAll(/^ {2}- (g[a-z_]+)$/gm)].map((m) => m[1])
    expect(new Set(declared)).toEqual(new Set(Tools.all.map((tool) => tool.name)))
  })
})

describe("gdrive_whoami", () => {
  test("reports credential, Drive identity, scope, and the share-with email", async () => {
    const out = await call(Tools.Whoami, {})
    expect(out).toContain("Credential: service account sa@p.iam.gserviceaccount.com")
    expect(out).toContain("Drive identity: sa@p.iam.gserviceaccount.com (Amp Bot)")
    expect(out).toContain(`Scope: ${Credential.SCOPE_FULL}`)
    expect(out).toContain("Files must be shared with sa@p.iam.gserviceaccount.com")
  })

  test("flags read-only mode", async () => {
    expect(await call(Tools.Whoami, {}, readOnlyRuntime)).toContain("(read-only mode)")
  })
})

describe("gdrive_search", () => {
  test("lists matches with ids and links", async () => {
    const out = await call(Tools.Search, { query: "Vision", type: "docs" })
    expect(out).toStartWith("1 result(s):")
    expect(out).toContain("- **Vision** (Google Doc)")
    expect(out).toContain("id: 1DocVision0000000000")
    expect(out).toContain("link: https://docs.google.com/document/d/1DocVision0000000000/edit")
  })

  test("explains an empty result", async () => {
    const out = await call(Tools.Search, {
      query: "nothing here",
      folder: "https://drive.google.com/drive/folders/1FolderSpecs0000000"
    })
    expect(out).toContain("No files found for query: trashed = false and")
    expect(out).toContain("'1FolderSpecs0000000' in parents")
    expect(out).toContain("gdrive_whoami")
  })
})

describe("gdocs_read", () => {
  test("renders a header and pages long content", async () => {
    const first = await call(Tools.ReadDoc, {
      file: "https://docs.google.com/document/d/1DocVision0000000000/edit",
      maxChars: 1000
    })
    expect(first).toStartWith("# Vision\n- Type: Google Doc\n- ID: 1DocVision0000000000")
    expect(first).toContain("# 1DocVision0000000000 as text/markdown")
    expect(first).toMatch(/_truncated: showing chars 0-1000 of \d+\. Call gdocs_read again with startChar=1000/)

    const rest = await call(Tools.ReadDoc, { file: "1DocVision0000000000", startChar: 1000, maxChars: 2000 })
    expect(rest).not.toContain("_truncated")
  })

  test("rejects an unparsable file reference at the schema boundary", async () => {
    const out = await call(Tools.ReadDoc, { file: "the vision doc" })
    expect(out).toStartWith("SchemaError:")
    expect(out).toContain("\"the vision doc\" is not a Google Drive file ID")
  })

  test("points folders at gdrive_search", async () => {
    const out = await call(Tools.ReadDoc, { file: "1FolderSpecs0000000" })
    expect(out).toContain("Specs is a folder.")
    expect(out).toContain("gdrive_search with folder=1FolderSpecs0000000")
  })

  test("turns 404 into a share-with hint naming the identity", async () => {
    const out = await call(Tools.ReadDoc, { file: "1Missing00000000000" })
    expect(out).toContain("Google API error 404 (notFound): File not found: 1Missing00000000000.")
    expect(out).toContain("not shared with sa@p.iam.gserviceaccount.com")
  })
})

describe("gsheets_read", () => {
  test("lists tabs and renders the selected tab as Markdown", async () => {
    const out = await call(Tools.ReadSheet, {
      file: "https://docs.google.com/spreadsheets/d/1SheetBacklog000000/edit#gid=77",
      maxRows: 2
    })
    expect(out).toContain("# Backlog")
    expect(out).toContain("- Tabs: Items (gid 0), Q3 plan (gid 77)")
    expect(out).toContain("- Range: 'Q3 plan' — 3 row(s), showing first 2")
    expect(out).toContain("| Task | Owner |")
    expect(out).toContain("| Ship plugin | Ari |")
    expect(out).not.toContain("range=")
  })

  test("csv output", async () => {
    const out = await call(Tools.ReadSheet, { file: "1SheetBacklog000000", range: "Items!A1:B3", format: "csv" })
    expect(out).toContain("Task,Owner\nShip plugin,Ari\nrange=Items!A1:B3,")
  })
})

describe("write tools", () => {
  test("gsheets_write update and append", async () => {
    expect(
      await call(Tools.WriteSheet, {
        file: "1SheetBacklog000000",
        range: "Items!A1:B2",
        values: [["a", 1], ["b", true]]
      })
    ).toBe(
      "Updated 4 cell(s) in Items!A1:B2"
    )
    expect(
      await call(Tools.WriteSheet, {
        file: "1SheetBacklog000000",
        range: "Items",
        values: [["c", null]],
        mode: "append"
      })
    ).toBe(
      "Appended 1 row(s) → Items:B2"
    )
  })

  test("gdocs_append and gdrive_comment_add", async () => {
    expect(await call(Tools.AppendDoc, { file: "1DocVision0000000000", text: "Decision: ship it" })).toContain("Vision")
    expect(await call(Tools.AddComment, { file: "1DocVision0000000000", content: "Looks good" })).toContain("c9")
  })

  test("refuse in read-only mode without calling Google", async () => {
    for (
      const [tool, input] of [
        [Tools.WriteSheet, { file: "1SheetBacklog000000", range: "A1", values: [["x"]] }],
        [Tools.AppendDoc, { file: "1DocVision0000000000", text: "x" }],
        [Tools.AddComment, { file: "1DocVision0000000000", content: "x" }]
      ] as const
    ) {
      const out = await call(tool, input, readOnlyRuntime)
      expect(out).toContain("Write tools are disabled because GOOGLE_WORKSPACE_READ_ONLY is set.")
      expect(out).toContain("amp orb restart-processes")
    }
  })
})

describe("gdrive_comments", () => {
  test("renders the file header and comments", async () => {
    const out = await call(Tools.Comments, { file: "1DocVision0000000000" })
    expect(out).toContain("# Vision")
    expect(out).toContain("## Comments (1)")
    expect(out).toContain("Clarify scope")
    expect(out).toContain("_comment id: c1_")
  })
})
