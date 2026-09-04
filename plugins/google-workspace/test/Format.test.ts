import { Tool } from "@scenesystems/amp-plugin-core"
import { describe, expect, test } from "@scenesystems/amp-plugin-testing"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Format from "../src/Format.ts"
import { MIME } from "../src/Model.ts"

describe("parseFileRef", () => {
  test("raw id", () => {
    expect(Format.parseFileRef("1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789")).toEqual(
      Option.some({ id: "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789" })
    )
  })

  test("doc url", () => {
    expect(Format.parseFileRef("https://docs.google.com/document/d/1AbC_def-123456/edit?tab=t.0")).toEqual(
      Option.some({ id: "1AbC_def-123456" })
    )
  })

  test("sheet url with gid", () => {
    expect(Format.parseFileRef("https://docs.google.com/spreadsheets/d/1SheetId_000/edit#gid=1712345")).toEqual(
      Option.some({ id: "1SheetId_000", gid: 1712345 })
    )
  })

  test("drive file, folder, and open?id= urls", () => {
    const id = (input: string) => Option.map(Format.parseFileRef(input), (ref) => ref.id)
    expect(id("https://drive.google.com/file/d/1FileId_000/view?usp=sharing")).toEqual(Option.some("1FileId_000"))
    expect(id("https://drive.google.com/drive/folders/1FolderId_000?usp=drive_link")).toEqual(
      Option.some("1FolderId_000")
    )
    expect(id("https://drive.google.com/open?id=1OpenId_000")).toEqual(Option.some("1OpenId_000"))
  })

  test("omits the gid key entirely when the URL has none", () => {
    const ref = Option.getOrThrow(Format.parseFileRef("https://docs.google.com/document/d/1AbC_def-123456/edit"))
    expect(Object.keys(ref)).toEqual(["id"])
  })

  test("rejects garbage", () => {
    expect(Format.parseFileRef("hello world")).toEqual(Option.none())
    expect(Format.parseFileRef("https://example.com/nothing")).toEqual(Option.none())
    expect(Format.parseFileRef("")).toEqual(Option.none())
    expect(Format.parseFileRef("http://[bad")).toEqual(Option.none())
  })
})

describe("FileRef schema", () => {
  const decode = Schema.decodeUnknownResult(Format.FileRef())
  const encode = Schema.encodeSync(Format.FileRef())

  test("decodes ids and urls to FileRef", () => {
    expect(decode("1AbCdEfGhIjKlMnOpQrStUvWxYz")).toEqual(Result.succeed({ id: "1AbCdEfGhIjKlMnOpQrStUvWxYz" }))
    expect(decode("https://docs.google.com/spreadsheets/d/1SheetId_000/edit#gid=7")).toEqual(
      Result.succeed({ id: "1SheetId_000", gid: 7 })
    )
  })

  test("fails with an actionable message", () => {
    const result = decode("not a file")
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure.message).toContain("\"not a file\" is not a Google Drive file ID")
    }
  })

  test("encodes back to the id", () => {
    expect(encode({ id: "abc", gid: 3 })).toBe("abc")
  })

  test("is a plain string in tool JSON Schema", () => {
    const schema = Tool.toInputSchema(Schema.Struct({ file: Format.FileRef("File") }))
    expect(schema.properties).toMatchObject({ file: { type: "string", description: "File" } })
    expect(schema.required).toEqual(["file"])
  })
})

describe("driveQuery", () => {
  test("escapes quotes and combines filters", () => {
    expect(Format.driveQuery({ text: "Ari's plan", mimeTypes: [MIME.doc], folderId: "F1" })).toBe(
      "trashed = false and (name contains 'Ari\\'s plan' or fullText contains 'Ari\\'s plan') and (mimeType = 'application/vnd.google-apps.document') and 'F1' in parents"
    )
  })

  test("nameOnly searches only names", () => {
    expect(Format.driveQuery({ text: "Roadmap", nameOnly: true })).toBe("trashed = false and name contains 'Roadmap'")
  })

  test("empty text and filters yield the trashed clause only", () => {
    expect(Format.driveQuery({ text: "   ", mimeTypes: [] })).toBe("trashed = false")
  })
})

describe("rendering", () => {
  test("markdown table escapes pipes and pads ragged rows", () => {
    const md = Format.toMarkdownTable([
      ["Name", "Status"],
      ["a|b", "done", "extra"],
      ["c"]
    ])
    expect(md).toBe(
      ["| Name | Status |  |", "| --- | --- | --- |", "| a\\|b | done | extra |", "| c |  |  |"].join("\n")
    )
  })

  test("no header row uses column letters", () => {
    expect(Format.toMarkdownTable([[1, 2]], { headerRow: false })).toStartWith("| A | B |")
  })

  test("empty range", () => {
    expect(Format.toMarkdownTable([])).toBe("_(empty range)_")
  })

  test("csv quoting", () => {
    expect(Format.toCsv([["a,b", "say \"hi\"", null, 3]])).toBe("\"a,b\",\"say \"\"hi\"\"\",,3")
  })

  test("column letters", () => {
    expect([0, 25, 26, 27, 701, 702].map(Format.columnLetter)).toEqual(["A", "Z", "AA", "AB", "ZZ", "AAA"])
  })

  test("quoteSheetTitle", () => {
    expect(Format.quoteSheetTitle("Sheet1")).toBe("Sheet1")
    expect(Format.quoteSheetTitle("Q3 'plan'")).toBe("'Q3 ''plan'''")
  })

  test("kindOf", () => {
    expect(Format.kindOf({ mimeType: MIME.sheet })).toBe("Google Sheet")
    expect(Format.kindOf({ mimeType: "text/plain" })).toBe("text/plain")
  })

  test("formatComments renders quotes, replies, and resolved state", () => {
    const out = Format.formatComments([
      {
        id: "c1",
        content: "Please clarify",
        createdTime: "2026-01-01T00:00:00Z",
        resolved: true,
        author: { displayName: "Ari" },
        quotedFileContent: { value: "line one\nline two" },
        replies: [{ id: "r1", content: "Done", action: "resolve", author: { emailAddress: "bob@example.com" } }]
      }
    ])
    expect(out).toContain("### Ari — 2026-01-01T00:00:00Z [resolved]")
    expect(out).toContain("> line one\n> line two")
    expect(out).toContain("- **bob@example.com** (resolve) : Done")
    expect(out).toContain("_comment id: c1_")
    expect(Format.formatComments([])).toBe("_(no comments)_")
  })
})

describe("truncate", () => {
  test("pages", () => {
    const text = "x".repeat(2500)
    const page = Format.truncate(text, { maxChars: 1000 })
    expect(page.text.length).toBe(1000)
    expect(page.truncated).toBe(true)
    expect(page.nextStart).toBe(1000)
    expect(page.total).toBe(2500)
    expect(Format.truncate(text, { startChar: 2000, maxChars: 1000 }).truncated).toBe(false)
  })

  test("clamps maxChars to at least 1000 and startChar to 0", () => {
    const page = Format.truncate("y".repeat(1500), { startChar: -5, maxChars: 10 })
    expect(page.text.length).toBe(1000)
    expect(page.nextStart).toBe(1000)
  })
})
