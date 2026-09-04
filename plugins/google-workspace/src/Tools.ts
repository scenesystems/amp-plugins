/**
 * The Google Workspace tool set.
 */
import { Tool, ToolError } from "@scenesystems/amp-plugin-core"
import * as Arr from "effect/Array"
import * as Effect from "effect/Effect"
import * as Match from "effect/Match"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Credential from "./Credential.ts"
import * as Format from "./Format.ts"
import { Google, type GoogleApiError } from "./Google.ts"
import { GoogleAuth } from "./GoogleAuth.ts"
import * as Model from "./Model.ts"

/**
 * Services every tool runs against.
 *
 * @category models
 */
export type Services = Google | GoogleAuth

const ENABLE_APIS_HINT =
  "Enable the Google Drive API, Google Docs API, and Google Sheets API in the Google Cloud project that owns these credentials."

/**
 * Turns Google/credential failures into `ToolError`s with a remediation hint the agent can act on.
 *
 * @category errors
 */
export const explain = <A, R>(
  self: Effect.Effect<A, GoogleApiError | Credential.CredentialError | ToolError.ToolError, R>
): Effect.Effect<A, ToolError.ToolError, R | GoogleAuth> =>
  self.pipe(
    Effect.catchTags({
      CredentialError: (error) =>
        new ToolError.ToolError({ message: `Google credential error: ${error.message}`, hint: error.hint }),
      GoogleApiError: (error) =>
        Effect.gen(function*() {
          const auth = yield* GoogleAuth
          const message = `Google API error ${error.status}${
            error.reason ? ` (${error.reason})` : ""
          }: ${error.message}`
          if (
            error.reason === "accessNotConfigured" || /has not been used in project|is disabled/i.test(error.message)
          ) {
            return yield* new ToolError.ToolError({ message, hint: ENABLE_APIS_HINT })
          }
          if (error.status === 403 || error.status === 404) {
            const who = yield* auth.credential.pipe(
              Effect.map(Credential.identity),
              Effect.orElseSucceed(() => "the plugin identity (run gdrive_whoami)")
            )
            const hint = error.status === 404
              ? `The file does not exist or is not shared with ${who}. Drive returns 404 for files the identity cannot see.`
              : `${who} lacks permission. Share the file (or its folder) with that identity, or check that the Drive/Docs/Sheets APIs are enabled in the Google Cloud project.`
            return yield* new ToolError.ToolError({ message, hint })
          }
          return yield* new ToolError.ToolError({ message })
        })
    })
  )

const requireWritable: Effect.Effect<void, ToolError.ToolError | Credential.CredentialError, GoogleAuth> = GoogleAuth
  .use((auth) => auth.readOnly)
  .pipe(
    Effect.filterOrFail(
      (readOnly) => !readOnly,
      () =>
        new ToolError.ToolError({
          message: "Write tools are disabled because GOOGLE_WORKSPACE_READ_ONLY is set.",
          hint: "Unset it (and run `amp orb restart-processes` in an orb) to enable writes."
        })
    ),
    Effect.asVoid
  )

const encodeRowsJson = Schema.encodeSync(Schema.fromJsonString(Model.Rows))

const File = Format.FileRef()

const TEXT_LIKE = /^text\/|json|xml|csv|markdown|yaml/i

const readFirstSheetTab = (file: Model.DriveFile) =>
  Effect.gen(function*() {
    const google = yield* Google
    const meta = yield* google.getSpreadsheet(file.id)
    return yield* Arr.match(meta.sheets, {
      onEmpty: () => Effect.succeed("_(spreadsheet has no tabs)_"),
      onNonEmpty: (sheets) =>
        google.getValues(file.id, Format.quoteSheetTitle(sheets[0].properties.title)).pipe(
          Effect.map((rows) =>
            `_First tab "${
              sheets[0].properties.title
            }" of ${sheets.length}; use gsheets_read for other tabs or ranges._\n\n${
              Format.toMarkdownTable(rows.slice(0, 200))
            }`
          )
        )
    })
  })

/**
 * The A1 range to read: an explicit range as given, a bare tab title quoted, or (when nothing is
 * requested) the tab the URL's `gid` named, else the first tab.
 */
const resolveRange = (
  sheets: ReadonlyArray<Model.SheetTab>,
  gid: number | undefined,
  requested: string | undefined
): Effect.Effect<string, ToolError.ToolError> =>
  Option.fromUndefinedOr(requested?.trim()).pipe(
    Option.filter((range) => range !== ""),
    Option.match({
      onNone: () =>
        Arr.findFirst(sheets, (s) => s.properties.sheetId === gid).pipe(
          Option.orElse(() => Arr.head(sheets)),
          Option.map((tab) => Format.quoteSheetTitle(tab.properties.title)),
          Effect.fromOption(() => new ToolError.ToolError({ message: "Spreadsheet has no tabs." }))
        ),
      onSome: (range) =>
        Effect.succeed(
          !range.includes("!") && sheets.some((s) => s.properties.title === range)
            ? Format.quoteSheetTitle(range)
            : range
        )
    })
  )

const readFileContent = (file: Model.DriveFile, format: "markdown" | "text") =>
  Match.value(file.mimeType).pipe(
    Match.when(Model.MIME.doc, () =>
      Google.use((google) => google.exportFile(file.id, format === "text" ? "text/plain" : "text/markdown"))),
    Match.when(Model.MIME.slides, () =>
      Google.use((google) => google.exportFile(file.id, "text/plain"))),
    Match.when(Model.MIME.sheet, () => readFirstSheetTab(file)),
    Match.when(Model.MIME.folder, () =>
      new ToolError.ToolError({
        message: `${file.name} is a folder.`,
        hint: `Use gdrive_search with folder=${file.id} to list its contents.`
      })),
    Match.when((mimeType) => TEXT_LIKE.test(mimeType), () => Google.use((google) => google.downloadFile(file.id))),
    Match.orElse((mimeType) =>
      new ToolError.ToolError({ message: `Cannot read ${mimeType} files as text (${file.name}).` })
    )
  )

/**
 * @category tools
 */
export const Whoami = Tool.make({
  name: "gdrive_whoami",
  title: "Check Google credentials",
  description:
    "Verify the Google credentials this plugin is using and report which identity Drive sees. Use this first when a Drive/Docs/Sheets tool fails with a permission error, and to learn which email files must be shared with.",
  input: Schema.Struct({}),
  execute: () =>
    explain(
      Effect.gen(function*() {
        const auth = yield* GoogleAuth
        const google = yield* Google
        const credential = yield* auth.credential
        const about = yield* google.about
        const readOnly = yield* auth.readOnly
        const scope = yield* auth.scope
        return Arr.getSomes([
          Option.some(`Credential: ${Credential.describe(credential)}`),
          Option.some(
            `Drive identity: ${about.user?.emailAddress ?? "unknown"}${
              about.user?.displayName ? ` (${about.user.displayName})` : ""
            }`
          ),
          Option.some(`Scope: ${scope}${readOnly ? " (read-only mode)" : ""}`),
          Option.map(
            Credential.robotEmail(credential),
            (robot) => `Files must be shared with ${robot} (or live in a folder/shared drive it can access).`
          )
        ]).join("\n")
      })
    )
})

const SearchType = Schema.Literals(["any", "docs", "sheets", "slides", "folders"])

const mimeTypesFor: Record<typeof SearchType.Type, ReadonlyArray<string> | undefined> = {
  any: undefined,
  docs: [Model.MIME.doc],
  sheets: [Model.MIME.sheet],
  slides: [Model.MIME.slides],
  folders: [Model.MIME.folder]
}

/**
 * @category tools
 */
export const Search = Tool.make({
  name: "gdrive_search",
  title: "Search Google Drive",
  transcriptGroup: { active: "Searching Google Drive", complete: "Searched Google Drive" },
  description:
    "Search Google Drive for files by name and/or full text. Filter by type (docs, sheets, slides, folders) or restrict to a folder. Returns id, type, modified time, and link for each match; pass the id to gdocs_read or gsheets_read.",
  input: Schema.Struct({
    query: Schema.optionalKey(Schema.String).annotate({
      description: "Words to search for in the file name and body. Omit to list everything matching the other filters."
    }),
    type: Schema.optionalKey(SearchType).annotate({
      description: "Restrict results to one Google file type. Default: any."
    }),
    folder: Schema.optionalKey(
      Format.FileRef("Folder ID or Drive folder URL. Only direct children of this folder are returned.")
    ),
    nameOnly: Schema.optionalKey(Schema.Boolean).annotate({
      description: "Match the query against file names only, not document contents. Default: false."
    }),
    limit: Schema.optionalKey(Schema.Finite).annotate({ description: "Maximum results (1-100). Default: 25." })
  }),
  execute: (input) =>
    explain(
      Effect.gen(function*() {
        const google = yield* Google
        const q = Format.driveQuery({
          text: input.query,
          nameOnly: input.nameOnly ?? false,
          mimeTypes: mimeTypesFor[input.type ?? "any"],
          folderId: input.folder?.id
        })
        const files = yield* google.listFiles({ q, pageSize: input.limit })
        if (files.length === 0) {
          return `No files found for query: ${q}\nIf the file exists, make sure it is shared with the plugin identity (run gdrive_whoami).`
        }
        return [`${files.length} result(s):`, ...files.map(Format.formatFileLine)].join("\n")
      })
    )
})

/**
 * @category tools
 */
export const FileInfo = Tool.make({
  name: "gdrive_file_info",
  title: "Google Drive file info",
  description:
    "Get metadata for one Drive file (name, type, owner, modified time, link). For a Google Sheet, also lists its tabs with sizes. Accepts a file ID or any docs.google.com / drive.google.com URL.",
  input: Schema.Struct({ file: File }),
  execute: ({ file }) =>
    explain(
      Effect.gen(function*() {
        const google = yield* Google
        const meta = yield* google.getFile(file.id)
        const tabs = meta.mimeType === Model.MIME.sheet
          ? yield* google.getSpreadsheet(meta.id).pipe(
            Effect.map((sheet) => ["", "## Tabs", ...sheet.sheets.map(Format.describeTab)])
          )
          : []
        return [Format.formatFileHeader(meta), ...tabs].join("\n")
      })
    )
})

/**
 * @category tools
 */
export const ReadDoc = Tool.make({
  name: "gdocs_read",
  title: "Read Google Doc",
  transcriptGroup: { active: "Reading Google Docs", complete: "Read Google Docs" },
  description:
    "Read the contents of a Google Doc as Markdown (or plain text). Also reads Google Slides (as text) and plain-text/Markdown/CSV files stored in Drive. If given a Google Sheet it returns the first tab; use gsheets_read for ranges. Long documents are paged: check `truncated` and pass startChar to continue.",
  input: Schema.Struct({
    file: File,
    format: Schema.optionalKey(Schema.Literals(["markdown", "text"])).annotate({
      description: "Export format for Google Docs. Default: markdown."
    }),
    startChar: Schema.optionalKey(Schema.Finite).annotate({
      description: "Character offset to start from when paging. Default: 0."
    }),
    maxChars: Schema.optionalKey(Schema.Finite).annotate({
      description: "Maximum characters to return. Default: 60000."
    })
  }),
  execute: (input) =>
    explain(
      Effect.gen(function*() {
        const google = yield* Google
        const file = yield* google.getFile(input.file.id)
        const content = yield* readFileContent(file, input.format ?? "markdown")
        const page = Format.truncate(content, { startChar: input.startChar, maxChars: input.maxChars })
        const footer = page.truncated
          ? `\n\n---\n_truncated: showing chars ${
            input.startChar ?? 0
          }-${page.nextStart} of ${page.total}. Call gdocs_read again with startChar=${page.nextStart} for more._`
          : ""
        return `${Format.formatFileHeader(file)}\n\n---\n\n${page.text}${footer}`
      })
    )
})

/**
 * @category tools
 */
export const ReadSheet = Tool.make({
  name: "gsheets_read",
  title: "Read Google Sheet",
  transcriptGroup: { active: "Reading Google Sheets", complete: "Read Google Sheets" },
  description:
    "Read a Google Sheet. With no range, lists the tabs and returns the first tab (or the tab named by #gid= in the URL). Pass an A1 range such as \"Roadmap!A1:F50\" or just a tab name to read that data. Output is a Markdown table by default; use format=csv for raw values or json for a 2D array.",
  input: Schema.Struct({
    file: File,
    range: Schema.optionalKey(Schema.String).annotate({
      description: "A1 notation range, e.g. \"Sheet1!A1:D20\", or a tab name for the whole tab. Optional."
    }),
    format: Schema.optionalKey(Schema.Literals(["markdown", "csv", "json"])).annotate({
      description: "Output format. Default: markdown."
    }),
    headerRow: Schema.optionalKey(Schema.Boolean).annotate({
      description: "Treat the first returned row as a header in Markdown output. Default: true."
    }),
    maxRows: Schema.optionalKey(Schema.Finite).annotate({ description: "Maximum rows to return. Default: 200." })
  }),
  execute: (input) =>
    explain(
      Effect.gen(function*() {
        const google = yield* Google
        const meta = yield* google.getSpreadsheet(input.file.id)
        const range = yield* resolveRange(meta.sheets, input.file.gid, input.range)
        const rows = yield* google.getValues(input.file.id, range)
        const maxRows = Math.max(input.maxRows ?? 200, 1)
        const shown = rows.slice(0, maxRows)
        const format = input.format ?? "markdown"
        const body = format === "json"
          ? encodeRowsJson(shown)
          : format === "csv"
          ? Format.toCsv(shown)
          : Format.toMarkdownTable(shown, { headerRow: input.headerRow !== false })
        return [
          `# ${meta.properties.title}`,
          `- ID: ${meta.spreadsheetId}`,
          meta.spreadsheetUrl ? `- Link: ${meta.spreadsheetUrl}` : undefined,
          `- Tabs: ${meta.sheets.map((s) => `${s.properties.title} (gid ${s.properties.sheetId})`).join(", ")}`,
          `- Range: ${range} — ${rows.length} row(s)${rows.length > maxRows ? `, showing first ${maxRows}` : ""}`,
          "",
          body
        ].filter((line) => line !== undefined).join("\n")
      })
    )
})

/**
 * @category tools
 */
export const Comments = Tool.make({
  name: "gdrive_comments",
  title: "List Google Drive comments",
  description:
    "List review comments (with quoted text and replies) on a Google Doc, Sheet, or Slides file. Use to see open feedback on a document. Resolved comments are hidden unless includeResolved is true.",
  input: Schema.Struct({
    file: File,
    includeResolved: Schema.optionalKey(Schema.Boolean).annotate({
      description: "Include resolved comments. Default: false."
    })
  }),
  execute: ({ file, includeResolved }) =>
    explain(
      Effect.gen(function*() {
        const google = yield* Google
        const [meta, comments] = yield* Effect.all(
          [google.getFile(file.id), google.listComments(file.id, { includeResolved: includeResolved ?? false })],
          { concurrency: 2 }
        )
        return `${Format.formatFileHeader(meta)}\n\n## Comments (${comments.length})\n\n${
          Format.formatComments(comments)
        }`
      })
    )
})

/**
 * @category tools
 */
export const WriteSheet = Tool.make({
  name: "gsheets_write",
  title: "Write Google Sheet",
  description:
    "Write a 2D array of values into a Google Sheet. mode=update overwrites the given A1 range; mode=append adds rows after the last row of data in the given tab/range. Values are parsed like typed input (numbers, dates, formulas starting with =).",
  input: Schema.Struct({
    file: File,
    range: Schema.String.annotate({
      description: "A1 range to write (update) or the tab/range to append below (append), e.g. \"Log!A1\"."
    }),
    values: Model.Rows.annotate({ description: "Rows of cell values." }),
    mode: Schema.optionalKey(Schema.Literals(["update", "append"])).annotate({ description: "Default: update." })
  }),
  execute: ({ file, mode, range, values }) =>
    explain(
      Effect.gen(function*() {
        yield* requireWritable
        const google = yield* Google
        if (mode === "append") {
          const result = yield* google.appendValues(file.id, range, values)
          return `Appended ${result.updates?.updatedRows ?? values.length} row(s) → ${
            result.updates?.updatedRange ?? range
          }`
        }
        const result = yield* google.updateValues(file.id, range, values)
        return `Updated ${result.updatedCells ?? "?"} cell(s) in ${result.updatedRange ?? range}`
      })
    )
})

/**
 * @category tools
 */
export const AppendDoc = Tool.make({
  name: "gdocs_append",
  title: "Append to Google Doc",
  description:
    "Append plain text to the end of a Google Doc (a newline is inserted before it). Use for adding notes, decisions, or generated sections. Markdown is not rendered; write plain prose.",
  input: Schema.Struct({
    file: File,
    text: Schema.String.annotate({ description: "Text to append." })
  }),
  execute: ({ file, text }) =>
    explain(
      Effect.gen(function*() {
        yield* requireWritable
        const google = yield* Google
        const meta = yield* google.getFile(file.id)
        if (meta.mimeType !== Model.MIME.doc) {
          return yield* new ToolError.ToolError({
            message: `${meta.name} is a ${Format.kindOf(meta.mimeType)}, not a Google Doc.`
          })
        }
        yield* google.appendDocumentText(file.id, `\n${text}`)
        return `Appended ${text.length} characters to "${meta.name}" (${meta.webViewLink ?? meta.id}).`
      })
    )
})

/**
 * @category tools
 */
export const AddComment = Tool.make({
  name: "gdrive_comment_add",
  title: "Add Google Drive comment",
  description:
    "Add a top-level (unanchored) comment to a Google Doc, Sheet, or Slides file. Use to leave review feedback that collaborators will see in the Google UI.",
  input: Schema.Struct({
    file: File,
    content: Schema.String.annotate({ description: "Comment text." })
  }),
  execute: ({ content, file }) =>
    explain(
      Effect.gen(function*() {
        yield* requireWritable
        const google = yield* Google
        const comment = yield* google.createComment(file.id, content)
        return `Added comment ${comment.id} as ${
          comment.author?.emailAddress ?? comment.author?.displayName ?? "plugin identity"
        }.`
      })
    )
})

/**
 * Every tool, in the order they are registered.
 *
 * @category tools
 */
export const all = [Whoami, Search, FileInfo, ReadDoc, ReadSheet, Comments, WriteSheet, AppendDoc, AddComment]
