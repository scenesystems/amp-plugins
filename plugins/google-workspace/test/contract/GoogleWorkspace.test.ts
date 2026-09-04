/**
 * Contract tests against the real Drive, Docs, and Sheets APIs.
 *
 * The unit suite's HTTP fakes encode our assumptions about Google's request and response shapes;
 * this suite is what keeps those assumptions honest. It runs the production `layer` with real
 * credentials, creates its fixtures inside `GOOGLE_WORKSPACE_CONTRACT_FOLDER`, and deletes them in
 * a scope finalizer so a failing assertion never leaves files behind.
 *
 * Run with `bun run test:contract`; see `setup.ts` for the required environment.
 */
import { describe, it } from "@effect/vitest"
import * as Assert from "@effect/vitest/utils"
import { Amp } from "@scenesystems/amp-plugin-core"
import { Assert as ExitAssert, PluginApi } from "@scenesystems/amp-plugin-testing"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Format from "../../src/Format.ts"
import { Google } from "../../src/Google.ts"
import { GoogleAuth } from "../../src/GoogleAuth.ts"
import { layer } from "../../src/index.ts"
import * as Model from "../../src/Model.ts"
import * as Tools from "../../src/Tools.ts"

const FOLDER = process.env["GOOGLE_WORKSPACE_CONTRACT_FOLDER"]!.trim()
const amp = PluginApi.make()
const Live = layer.pipe(Layer.provide(Amp.layer(amp.api)))

/** A uniquely named fixture file in the contract folder, deleted when the scope closes. */
const fixture = (kind: "Doc" | "Sheet") =>
  Effect.acquireRelease(
    Effect.gen(function*() {
      const now = yield* DateTime.now
      const google = yield* Google
      return yield* google.createFile({
        name: `amp-plugins contract ${kind} ${DateTime.formatIso(now)}`,
        mimeType: kind === "Doc" ? Model.MIME.doc : Model.MIME.sheet,
        parents: [FOLDER]
      })
    }),
    (file) => Google.use((google) => google.deleteFile(file.id)).pipe(Effect.orDie)
  )

describe("Google Workspace contract", () => {
  // `excludeTestServices`: the real clock must drive JWT timestamps and token expiry.
  it.layer(Live, { excludeTestServices: true, timeout: "60 seconds" })("with the production layer", (it) => {
    it.effect("the credential mints a token and Drive reports the identity gdrive_whoami would show", () =>
      Effect.gen(function*() {
        const auth = yield* GoogleAuth
        const google = yield* Google
        const about = yield* google.about
        Assert.assertDefined(about.user?.emailAddress)
        const whoami = PluginApi.text(yield* Tools.Whoami.execute({}, amp.toolContext))
        Assert.assertInclude(whoami, `Drive identity: ${about.user.emailAddress}`)
        Assert.assertInclude(whoami, `Scope: ${yield* auth.scope}`)
      }))

    it.effect("Docs: create, append, export, comment, list, read through gdocs_read, delete", () =>
      Effect.gen(function*() {
        const google = yield* Google
        const doc = yield* fixture("Doc")
        Assert.strictEqual(doc.mimeType, Model.MIME.doc)
        Assert.deepStrictEqual(doc.parents, [FOLDER])

        yield* google.appendDocumentText(doc.id, "\nContract line one.")
        Assert.assertInclude(yield* google.exportFile(doc.id, "text/plain"), "Contract line one.")
        Assert.assertInclude(yield* google.exportFile(doc.id, "text/markdown"), "Contract line one.")

        const comment = yield* google.createComment(doc.id, "Contract comment")
        const listed = yield* google.listComments(doc.id, { includeResolved: false })
        Assert.deepStrictEqual(
          listed.map((c) => ({ id: c.id, content: c.content })),
          [{ id: comment.id, content: "Contract comment" }]
        )

        const found = yield* google.listFiles({
          q: Format.driveQuery({ text: doc.name, nameOnly: true, folderId: FOLDER })
        })
        Assert.deepStrictEqual(found.map((f) => f.id), [doc.id])

        const fetched = yield* google.getFile(doc.id)
        Assert.strictEqual(fetched.name, doc.name)
        Assert.assertDefined(fetched.webViewLink)

        const read = PluginApi.text(yield* Tools.ReadDoc.execute({ file: { id: doc.id } }, amp.toolContext))
        Assert.assertTrue(read.startsWith(`# ${doc.name}\n- Type: Google Doc\n- ID: ${doc.id}\n`), read)
        Assert.assertInclude(read, "\n\n---\n\n")
        Assert.assertInclude(read, "Contract line one.")
      }))

    it.effect("Sheets: create, update, read back formatted values, append, delete", () =>
      Effect.gen(function*() {
        const google = yield* Google
        const sheet = yield* fixture("Sheet")
        Assert.strictEqual(sheet.mimeType, Model.MIME.sheet)

        const meta = yield* google.getSpreadsheet(sheet.id)
        Assert.strictEqual(meta.spreadsheetId, sheet.id)
        Assert.strictEqual(meta.properties.title, sheet.name)
        const tab = meta.sheets[0]
        Assert.assertDefined(tab)
        const range = (a1: string) => `${Format.quoteSheetTitle(tab.properties.title)}!${a1}`

        const updated = yield* google.updateValues(sheet.id, range("A1:B2"), [["a", 1], ["b", 2]])
        Assert.strictEqual(updated.updatedCells, 4)
        Assert.strictEqual(updated.updatedRange, range("A1:B2"))
        // USER_ENTERED input plus FORMATTED_VALUE rendering: numbers come back as their display strings.
        Assert.deepStrictEqual(yield* google.getValues(sheet.id, range("A1:B2")), [["a", "1"], ["b", "2"]])

        const appended = yield* google.appendValues(sheet.id, Format.quoteSheetTitle(tab.properties.title), [["c", 3]])
        Assert.strictEqual(appended.updates?.updatedRange, range("A3:B3"))
        Assert.strictEqual(appended.updates?.updatedRows, 1)
        Assert.deepStrictEqual(yield* google.getValues(sheet.id, range("A1:B3")), [["a", "1"], ["b", "2"], ["c", "3"]])

        const read = PluginApi.text(
          yield* Tools.ReadSheet.execute({ file: { id: sheet.id }, format: "csv" }, amp.toolContext)
        )
        Assert.assertInclude(
          read,
          `- Range: ${Format.quoteSheetTitle(tab.properties.title)} — 3 row(s)\n\na,1\nb,2\nc,3`
        )
      }))

    it.effect("a file that does not exist is a 404 the tools explain with the identity to share with", () =>
      Effect.gen(function*() {
        const exit = yield* Effect.exit(
          Tools.FileInfo.execute({ file: { id: "1NoSuchFile000000000000" } }, amp.toolContext)
        )
        const error = ExitAssert.failureOf(exit)
        Assert.assertTrue(error.message.startsWith("Google API error 404 (notFound): "), error.message)
        Assert.assertDefined(error.hint)
        Assert.assertTrue(error.hint.startsWith("The file does not exist or is not shared with "), error.hint)
      }))
  })
})
