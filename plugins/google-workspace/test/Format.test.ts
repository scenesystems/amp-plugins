import { describe, it } from "@effect/vitest"
import * as Assert from "@effect/vitest/utils"
import * as Option from "effect/Option"
import * as FastCheck from "effect/testing/FastCheck"
import * as TestSchema from "effect/testing/TestSchema"
import * as Format from "../src/Format.ts"
import * as Model from "../src/Model.ts"

// --- arbitraries -----------------------------------------------------------------------------

const idChar = FastCheck.constantFrom(..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-".split(""))
const fileId = FastCheck.string({ unit: idChar, minLength: 10, maxLength: 60 })
const gid = FastCheck.nat({ max: 2_147_483_647 })

/** Every URL shape Google hands out for a file, with and without a `#gid=` fragment. */
const googleUrl = FastCheck.record({
  id: fileId,
  gid: FastCheck.option(gid, { nil: undefined }),
  shape: FastCheck.constantFrom(
    "document",
    "spreadsheets",
    "presentation",
    "file",
    "folders",
    "open",
    "spreadsheets-query-gid"
  ),
  host: FastCheck.constantFrom("https://docs.google.com", "https://drive.google.com", "http://docs.google.com")
}).map(({ gid, host, id, shape }) => {
  const fragment = gid === undefined ? "" : `#gid=${gid}`
  const url = shape === "folders"
    ? `${host}/drive/folders/${id}?usp=sharing${fragment}`
    : shape === "open"
    ? `${host}/open?id=${id}${fragment}`
    : shape === "spreadsheets-query-gid"
    ? `${host}/spreadsheets/d/${id}/edit${gid === undefined ? "" : `?gid=${gid}`}`
    : `${host}/${shape}/d/${id}/edit?usp=sharing${fragment}`
  return { url, expected: gid === undefined ? { id } : { id, gid } }
})

const cell: FastCheck.Arbitrary<Model.CellValue> = FastCheck.oneof(
  FastCheck.string({ unit: "grapheme" }),
  FastCheck.string(),
  FastCheck.constantFrom(
    "a|b",
    "line\nbreak",
    "cr\rlf\n",
    "bare\rcr",
    "quote\"d",
    "comma,separated",
    "  padded  ",
    "'single'"
  ),
  FastCheck.double({ noNaN: true, noDefaultInfinity: true }),
  FastCheck.boolean(),
  FastCheck.constant(null)
)
const rows = FastCheck.array(FastCheck.array(cell, { minLength: 1, maxLength: 6 }), { minLength: 1, maxLength: 8 })

// --- helpers ---------------------------------------------------------------------------------

const cellText = (value: Model.CellValue | undefined): string =>
  value === null || value === undefined ? "" : String(value)

/**
 * Strict RFC 4180 reader. Quoted fields may hold commas, doubled quotes, and line breaks; an unquoted field may
 * not contain `"`, `\r`, or `\n`, and a closing quote must be followed by a separator. Anything else throws, so
 * the round-trip property fails if `toCsv` ever emits something a conforming reader would reject.
 */
const parseCsv = (csv: string): Array<Array<string>> => {
  const out: Array<Array<string>> = []
  let row: Array<string> = []
  let i = 0
  const fail = (why: string): never => {
    throw new Error(`${why} at offset ${i} in ${JSON.stringify(csv)}`)
  }
  const readField = (): string => {
    let field = ""
    if (csv[i] === "\"") {
      i++
      for (;;) {
        if (i >= csv.length) return fail("unterminated quoted field")
        const ch = csv[i]!
        if (ch === "\"") {
          if (csv[i + 1] === "\"") {
            field += "\""
            i += 2
            continue
          }
          i++
          if (i < csv.length && csv[i] !== "," && csv[i] !== "\n") fail("text after closing quote")
          return field
        }
        field += ch
        i++
      }
    }
    while (i < csv.length && csv[i] !== "," && csv[i] !== "\n") {
      const ch = csv[i]!
      if (ch === "\"" || ch === "\r") fail(`unquoted ${JSON.stringify(ch)}`)
      field += ch
      i++
    }
    return field
  }
  for (;;) {
    row.push(readField())
    if (i >= csv.length) break
    if (csv[i] === ",") {
      i++
    } else {
      i++
      out.push(row)
      row = []
    }
  }
  out.push(row)
  return out
}

/** Splits a Markdown table row on unescaped pipes, returning the trimmed cells. */
const splitTableRow = (line: string): Array<string> => {
  const cells: Array<string> = []
  let current = ""
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!
    if (ch === "\\" && line[i + 1] === "|") {
      current += "|"
      i++
    } else if (ch === "|") {
      cells.push(current)
      current = ""
    } else {
      current += ch
    }
  }
  cells.push(current)
  // A well-formed row starts and ends with a pipe, so the first and last pieces are the empty margins.
  Assert.strictEqual(cells[0], "", `row must start with a pipe: ${line}`)
  Assert.strictEqual(cells[cells.length - 1], "", `row must end with a pipe: ${line}`)
  return cells.slice(1, -1).map((c) => c.trim())
}

/** Inverse of `columnLetter`: A → 0, Z → 25, AA → 26. */
const columnIndex = (letters: string): number =>
  letters.split("").reduce((acc, ch) => acc * 26 + (ch.charCodeAt(0) - 64), 0) - 1

/** Reads the single-quoted literal following `prefix` in a Drive query and unescapes it. */
const quotedAfter = (query: string, prefix: string): string => {
  const start = query.indexOf(prefix)
  Assert.assertTrue(start >= 0, `expected ${JSON.stringify(prefix)} in ${query}`)
  let i = start + prefix.length
  Assert.strictEqual(query[i], "'")
  i++
  let out = ""
  for (; i < query.length; i++) {
    const ch = query[i]!
    if (ch === "\\") {
      const next = query[i + 1]
      Assert.assertTrue(next === "\\" || next === "'", `only \\\\ and \\' are valid escapes, got \\${next}`)
      out += next
      i++
    } else if (ch === "'") {
      return out
    } else {
      out += ch
    }
  }
  throw new Error(`unterminated literal in ${query}`)
}

const doc = new Model.DriveFile({
  id: "1DocVision0000000000",
  name: "Vision",
  mimeType: Model.MIME.doc,
  modifiedTime: "2026-09-01T10:00:00Z",
  webViewLink: "https://docs.google.com/document/d/1DocVision0000000000/edit",
  owners: [{ emailAddress: "ari@scenesystems.io", displayName: "Ari" }],
  lastModifyingUser: { emailAddress: "sam@scenesystems.io" },
  description: "Where we are going."
})

// --- parseFileRef ----------------------------------------------------------------------------

describe("Format.parseFileRef", () => {
  it.prop("recovers the id (and gid) from every Google URL shape", { url: googleUrl }, ({ url }) => {
    Assert.deepStrictEqual(Option.getOrUndefined(Format.parseFileRef(url.url)), url.expected)
  })

  it.prop("accepts a bare id of at least ten id characters, trimmed", { id: fileId }, ({ id }) => {
    Assert.deepStrictEqual(Option.getOrUndefined(Format.parseFileRef(`  ${id}\n`)), { id })
  })

  it.prop(
    "rejects anything that is neither a URL nor an id",
    {
      input: FastCheck.string().filter((s) => !/^[A-Za-z0-9_-]{10,}$/.test(s.trim()) && !/^https?:\/\//i.test(s.trim()))
    },
    ({ input }) => {
      Assert.assertNone(Format.parseFileRef(input))
    }
  )

  it.each([
    { input: "short", why: "shorter than ten characters" },
    { input: "has space in it", why: "contains a space" },
    { input: "https://example.com/document/d/", why: "a URL without an id" },
    { input: "https://drive.google.com/drive/my-drive", why: "a Drive URL with no file" },
    { input: "http://[::1", why: "not a parseable URL" }
  ])("rejects $input ($why)", ({ input }) => {
    Assert.assertNone(Format.parseFileRef(input))
  })

  it("prefers the fragment gid over a query gid", () => {
    Assert.deepStrictEqual(
      Option.getOrUndefined(
        Format.parseFileRef("https://docs.google.com/spreadsheets/d/1SheetId000000000000/edit?gid=5#gid=9")
      ),
      { id: "1SheetId000000000000", gid: 9 }
    )
  })
})

describe("Format.FileRef schema", () => {
  const asserts = new TestSchema.Asserts(Format.FileRef())

  it("decodes ids and URLs into a FileRef", async () => {
    await asserts.decoding().succeed("1DocVision0000000000", { id: "1DocVision0000000000" })
    await asserts.decoding().succeed("https://docs.google.com/spreadsheets/d/1SheetId000000000000/edit#gid=7", {
      id: "1SheetId000000000000",
      gid: 7
    })
  })

  it("fails decoding with a message the agent can act on", async () => {
    await asserts.decoding().fail(
      "nope",
      "\"nope\" is not a Google Drive file ID or docs.google.com/drive.google.com URL."
    )
    await asserts.decoding().fail(42, "Expected string")
  })

  it("encodes back to the bare id, dropping the gid", async () => {
    await asserts.encoding().succeed({ id: "1DocVision0000000000", gid: 3 }, "1DocVision0000000000")
    await asserts.encoding().succeed({ id: "1DocVision0000000000" }, "1DocVision0000000000")
  })

  it("exposes the description on the string side, where the JSON Schema is generated from", () => {
    Assert.strictEqual(Format.FileRef().ast.annotations?.["description"], undefined)
    Assert.strictEqual(
      Format.FileRef("Folder ID.").ast.encoding?.[0]?.to.annotations?.["description"],
      "Folder ID."
    )
    Assert.strictEqual(
      Format.FileRef().ast.encoding?.[0]?.to.annotations?.["description"],
      "Drive file ID or any docs.google.com / drive.google.com URL."
    )
  })
})

// --- driveQuery -------------------------------------------------------------------------------

describe("Format.driveQuery", () => {
  it("excludes trashed files and nothing else by default", () => {
    Assert.strictEqual(Format.driveQuery({}), "trashed = false")
    Assert.strictEqual(Format.driveQuery({ text: "   " }), "trashed = false")
    Assert.strictEqual(Format.driveQuery({ trashed: true, mimeTypes: [] }), "trashed = true")
  })

  it("combines text, type, and folder clauses in a fixed order", () => {
    Assert.strictEqual(
      Format.driveQuery({
        text: "roadmap",
        mimeTypes: [Model.MIME.doc, Model.MIME.sheet],
        folderId: "1Folder000000000000"
      }),
      "trashed = false and (name contains 'roadmap' or fullText contains 'roadmap') and (mimeType = 'application/vnd.google-apps.document' or mimeType = 'application/vnd.google-apps.spreadsheet') and '1Folder000000000000' in parents"
    )
    Assert.strictEqual(
      Format.driveQuery({ text: "roadmap", nameOnly: true }),
      "trashed = false and name contains 'roadmap'"
    )
  })

  it("escapes the characters Drive treats specially", () => {
    Assert.strictEqual(
      Format.driveQuery({ text: "Ari's \\ plan", nameOnly: true }),
      "trashed = false and name contains 'Ari\\'s \\\\ plan'"
    )
  })

  it.prop(
    "quotes any search text so that it reads back as the trimmed input",
    { text: FastCheck.string().filter((s) => s.trim() !== ""), nameOnly: FastCheck.boolean() },
    ({ nameOnly, text }) => {
      const query = Format.driveQuery({ text, nameOnly })
      Assert.strictEqual(quotedAfter(query, "name contains "), text.trim())
      if (!nameOnly) Assert.strictEqual(quotedAfter(query, "fullText contains "), text.trim())
    }
  )

  it.prop("quotes the folder id", { folderId: FastCheck.string({ minLength: 1 }) }, ({ folderId }) => {
    Assert.strictEqual(quotedAfter(Format.driveQuery({ folderId }), "and "), folderId)
  })
})

// --- rendering ----------------------------------------------------------------------------------

describe("Format.kindOf", () => {
  it.each([
    { mimeType: Model.MIME.doc, kind: "Google Doc" },
    { mimeType: Model.MIME.sheet, kind: "Google Sheet" },
    { mimeType: Model.MIME.slides, kind: "Google Slides" },
    { mimeType: Model.MIME.folder, kind: "Folder" },
    { mimeType: "text/csv", kind: "text/csv" }
  ])("$mimeType → $kind", ({ kind, mimeType }) => {
    Assert.strictEqual(Format.kindOf({ mimeType }), kind)
  })
})

describe("Format.formatFileLine", () => {
  it("renders name, kind, id, modified-by-owner, and link", () => {
    Assert.strictEqual(
      Format.formatFileLine(doc),
      [
        "- **Vision** (Google Doc)",
        "  id: 1DocVision0000000000",
        "  modified: 2026-09-01T10:00:00Z by ari@scenesystems.io",
        "  link: https://docs.google.com/document/d/1DocVision0000000000/edit"
      ].join("\n")
    )
  })

  it("falls back to the last modifying user and omits missing lines", () => {
    const bare = new Model.DriveFile({
      id: "1Bare000000000000000",
      name: "Bare",
      mimeType: "text/csv",
      modifiedTime: "2026-01-01T00:00:00Z",
      lastModifyingUser: { emailAddress: "sam@scenesystems.io" }
    })
    Assert.strictEqual(
      Format.formatFileLine(bare),
      "- **Bare** (text/csv)\n  id: 1Bare000000000000000\n  modified: 2026-01-01T00:00:00Z by sam@scenesystems.io"
    )
    Assert.strictEqual(
      Format.formatFileLine(new Model.DriveFile({ id: "1Bare000000000000000", name: "Bare", mimeType: "text/csv" })),
      "- **Bare** (text/csv)\n  id: 1Bare000000000000000"
    )
  })
})

describe("Format.formatFileHeader", () => {
  it("renders every known field in order", () => {
    Assert.strictEqual(
      Format.formatFileHeader(doc),
      [
        "# Vision",
        "- Type: Google Doc",
        "- ID: 1DocVision0000000000",
        "- Link: https://docs.google.com/document/d/1DocVision0000000000/edit",
        "- Modified: 2026-09-01T10:00:00Z by sam@scenesystems.io",
        "- Owner: ari@scenesystems.io",
        "- Description: Where we are going."
      ].join("\n")
    )
  })

  it("uses display names when emails are hidden and skips empty owner lists", () => {
    const shared = new Model.DriveFile({
      id: "1Shared0000000000000",
      name: "Shared",
      mimeType: Model.MIME.sheet,
      modifiedTime: "2026-02-02T00:00:00Z",
      lastModifyingUser: { displayName: "Sam" },
      owners: []
    })
    Assert.strictEqual(
      Format.formatFileHeader(shared),
      "# Shared\n- Type: Google Sheet\n- ID: 1Shared0000000000000\n- Modified: 2026-02-02T00:00:00Z by Sam"
    )
  })
})

describe("Format.describeTab", () => {
  it("shows title, gid, and grid size", () => {
    Assert.strictEqual(
      Format.describeTab({
        properties: { sheetId: 42, title: "Roadmap", gridProperties: { rowCount: 100, columnCount: 8 } }
      }),
      "- Roadmap (gid 42) — 100 rows × 8 cols"
    )
    Assert.strictEqual(
      Format.describeTab({ properties: { sheetId: 0, title: "Sheet1", gridProperties: { rowCount: 5 } } }),
      "- Sheet1 (gid 0) — 5 rows × ? cols"
    )
    Assert.strictEqual(Format.describeTab({ properties: { sheetId: 0, title: "Sheet1" } }), "- Sheet1 (gid 0)")
  })
})

describe("Format.columnLetter", () => {
  it.each([
    { index: 0, letters: "A" },
    { index: 25, letters: "Z" },
    { index: 26, letters: "AA" },
    { index: 51, letters: "AZ" },
    { index: 52, letters: "BA" },
    { index: 701, letters: "ZZ" },
    { index: 702, letters: "AAA" }
  ])("$index → $letters", ({ index, letters }) => {
    Assert.strictEqual(Format.columnLetter(index), letters)
  })

  it.prop("is inverted by base-26 bijective decoding", { index: FastCheck.nat({ max: 100_000 }) }, ({ index }) => {
    const letters = Format.columnLetter(index)
    Assert.assertMatch(letters, /^[A-Z]+$/)
    Assert.strictEqual(columnIndex(letters), index)
  })
})

describe("Format.toMarkdownTable", () => {
  it("renders an empty range as a placeholder", () => {
    Assert.strictEqual(Format.toMarkdownTable([]), "_(empty range)_")
  })

  it("uses the first row as header, pads ragged rows, and escapes pipes and newlines", () => {
    Assert.strictEqual(
      Format.toMarkdownTable([["Name", "Status"], ["a|b", "in\nprogress", "extra"], [null, true, 3]]),
      [
        "| Name | Status |  |",
        "| --- | --- | --- |",
        "| a\\|b | in progress | extra |",
        "|  | true | 3 |"
      ].join("\n")
    )
  })

  it("labels columns A, B, C… when the data has no header row", () => {
    Assert.strictEqual(
      Format.toMarkdownTable([[1, 2], [3]], { headerRow: false }),
      "| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 |  |"
    )
  })

  it.prop("has one line per row plus header/separator, every line with exactly `width` cells", {
    rows,
    headerRow: FastCheck.boolean()
  }, ({ headerRow, rows }) => {
    const width = Math.max(...rows.map((r) => r.length))
    const lines = Format.toMarkdownTable(rows, { headerRow }).split("\n")
    Assert.strictEqual(lines.length, headerRow ? rows.length + 1 : rows.length + 2)
    for (const line of lines) Assert.strictEqual(splitTableRow(line).length, width, line)
    Assert.deepStrictEqual(splitTableRow(lines[1]!), Array.from({ length: width }, () => "---"))
    const body = lines.slice(2).map(splitTableRow)
    const expected = (headerRow ? rows.slice(1) : rows).map((row) =>
      Array.from({ length: width }, (_, i) => cellText(row[i]).replace(/\r?\n/g, " ").trim())
    )
    Assert.deepStrictEqual(body, expected)
  })
})

describe("Format.toCsv", () => {
  it("quotes only the fields that need it and doubles embedded quotes", () => {
    Assert.strictEqual(
      Format.toCsv([["plain", "with,comma", "with\"quote", "multi\nline", null, 1.5, false]]),
      "plain,\"with,comma\",\"with\"\"quote\",\"multi\nline\",,1.5,false"
    )
  })

  it.prop(
    "round-trips through an RFC 4180 reader",
    { rows },
    ({ rows }) => {
      Assert.deepStrictEqual(parseCsv(Format.toCsv(rows)), rows.map((row) => row.map(cellText)))
    }
  )
})

describe("Format.quoteSheetTitle", () => {
  it("leaves identifier-like titles alone and quotes everything else", () => {
    Assert.strictEqual(Format.quoteSheetTitle("Sheet1"), "Sheet1")
    Assert.strictEqual(Format.quoteSheetTitle("Q3_Plan"), "Q3_Plan")
    Assert.strictEqual(Format.quoteSheetTitle("My Tab"), "'My Tab'")
    Assert.strictEqual(Format.quoteSheetTitle("Ari's"), "'Ari''s'")
    Assert.strictEqual(Format.quoteSheetTitle(""), "''")
  })

  it.prop("produces a range prefix that unquotes to the title", { title: FastCheck.string() }, ({ title }) => {
    const quoted = Format.quoteSheetTitle(title)
    if (/^[A-Za-z0-9_]+$/.test(title)) {
      Assert.strictEqual(quoted, title)
    } else {
      Assert.assertMatch(quoted, /^'.*'$/s)
      Assert.strictEqual(quoted.slice(1, -1).replace(/''/g, "'"), title)
    }
  })
})

describe("Format.formatComments", () => {
  it("renders a placeholder for no comments", () => {
    Assert.strictEqual(Format.formatComments([]), "_(no comments)_")
  })

  it("renders author, time, status, quoted text, replies with actions, and the id", () => {
    const comments = [
      new Model.DriveComment({
        id: "c1",
        author: { displayName: "Ari", emailAddress: "ari@scenesystems.io" },
        content: "Tighten this paragraph.",
        quotedFileContent: { value: "We will\nship soon." },
        createdTime: "2026-09-01T00:00:00Z",
        replies: [
          {
            id: "r1",
            author: { emailAddress: "sam@scenesystems.io" },
            content: "Done.",
            action: "resolve",
            createdTime: "2026-09-02T00:00:00Z"
          },
          { id: "r2" }
        ]
      }),
      new Model.DriveComment({ id: "c2", resolved: true, content: "Old note" })
    ]
    Assert.strictEqual(
      Format.formatComments(comments),
      [
        "### Ari — 2026-09-01T00:00:00Z",
        "> We will",
        "> ship soon.",
        "Tighten this paragraph.",
        "  - **sam@scenesystems.io** (resolve) 2026-09-02T00:00:00Z: Done.",
        "  - **unknown** : ",
        "  _comment id: c1_",
        "",
        "### unknown —  [resolved]",
        "Old note",
        "  _comment id: c2_"
      ].join("\n")
    )
  })
})

describe("Format.truncate", () => {
  it("returns the whole text with no next page when it fits", () => {
    Assert.deepStrictEqual(Format.truncate("hello", {}), {
      text: "hello",
      truncated: false,
      total: 5,
      nextStart: undefined
    })
  })

  it("clamps maxChars up to 1000 and startChar down to 0", () => {
    const text = "x".repeat(2500)
    Assert.deepStrictEqual(Format.truncate(text, { maxChars: 10, startChar: -50 }), {
      text: "x".repeat(1000),
      truncated: true,
      total: 2500,
      nextStart: 1000
    })
  })

  it.prop(
    "pages concatenate back to the original text",
    {
      text: FastCheck.string({ maxLength: 5000, unit: "grapheme" }),
      maxChars: FastCheck.integer({ min: 0, max: 3000 })
    },
    ({ maxChars, text }) => {
      const pages: Array<Format.Page> = []
      let start: number | undefined = 0
      while (start !== undefined) {
        const page: Format.Page = Format.truncate(text, { startChar: start, maxChars })
        pages.push(page)
        Assert.strictEqual(page.total, text.length)
        Assert.assertTrue(page.text.length <= Math.max(maxChars, 1000))
        Assert.strictEqual(page.truncated, page.nextStart !== undefined)
        start = page.nextStart
      }
      Assert.strictEqual(pages.map((p) => p.text).join(""), text)
      Assert.assertTrue(pages.slice(0, -1).every((p) => p.text.length === Math.max(maxChars, 1000)))
    }
  )
})
