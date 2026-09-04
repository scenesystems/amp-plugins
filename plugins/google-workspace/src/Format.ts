/**
 * Pure helpers: file reference parsing, Drive query building, and Markdown rendering.
 */
import * as Arr from "effect/Array"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Record from "effect/Record"
import * as Schema from "effect/Schema"
import * as Getter from "effect/SchemaGetter"
import * as Issue from "effect/SchemaIssue"
import type { CellValue, DriveComment, DriveFile, Rows, SheetTab } from "./Model.ts"
import { MIME } from "./Model.ts"

const FileRefStruct = Schema.Struct({
  id: Schema.String,
  gid: Schema.optionalKey(Schema.Finite)
})

/**
 * A resolved Drive file reference: the file ID plus the sheet tab `gid` when the URL carried one.
 *
 * @category models
 */
export type FileRef = typeof FileRefStruct.Type

const fileRef = (id: string, gid: Option.Option<number>): FileRef =>
  Option.match(gid, { onNone: () => ({ id }), onSome: (gid) => ({ id, gid }) })

const ID_PATTERN = /^[A-Za-z0-9_-]{10,}$/
const PATH_PATTERNS = [
  // /document/d/<id>, /spreadsheets/d/<id>, /file/d/<id>, /presentation/d/<id>
  /\/d\/([A-Za-z0-9_-]+)/,
  // /drive/folders/<id>
  /\/folders\/([A-Za-z0-9_-]+)/
]

/**
 * Parses a raw Drive file ID or any docs.google.com / drive.google.com URL.
 *
 * @category parsing
 */
export const parseFileRef = (input: string): Option.Option<FileRef> => {
  const raw = input.trim()
  if (raw === "") return Option.none()
  if (!/^https?:\/\//i.test(raw)) {
    return ID_PATTERN.test(raw) ? Option.some({ id: raw }) : Option.none()
  }
  return parseUrl(raw).pipe(
    Option.flatMap((url) => {
      const gid = Option.orElse(firstGroup(/gid=(\d+)/, url.hash), () => firstGroup(/gid=(\d+)/, url.search)).pipe(
        Option.map(Number)
      )
      const fromPath = Arr.findFirst(PATH_PATTERNS, (pattern) => firstGroup(pattern, url.pathname))
      const fromQuery = Option.fromNullishOr(url.searchParams.get("id")).pipe(Option.filter((id) => id !== ""))
      return Option.map(Option.orElse(fromPath, () => fromQuery), (id) => fileRef(id, gid))
    })
  )
}

const parseUrl = Option.liftThrowable((raw: string) => new URL(raw))

/** The first capture group of `pattern` in `subject`, when it matches. */
const firstGroup = (pattern: RegExp, subject: string): Option.Option<string> =>
  Option.fromNullishOr(pattern.exec(subject)).pipe(Option.flatMap((match) => Option.fromUndefinedOr(match[1])))

/**
 * Tool-input schema for a file: encoded as a string (ID or URL), decoded to a `FileRef`.
 * Invalid references fail decoding with a message the agent can act on.
 *
 * The description is attached to the string side, which is what `Tool.toInputSchema` turns into
 * JSON Schema; annotating the transformation itself would not reach the agent.
 *
 * @category schemas
 */
export const FileRef = (
  description = "Drive file ID or any docs.google.com / drive.google.com URL."
): Schema.decodeTo<typeof FileRefStruct, Schema.String> =>
  Schema.String.annotate({ description }).pipe(
    Schema.decodeTo(FileRefStruct, {
      decode: Getter.transformOrFail((input: string) =>
        Effect.fromOption(
          parseFileRef(input),
          () =>
            new Issue.InvalidValue(
              { message: `"${input}" is not a Google Drive file ID or docs.google.com/drive.google.com URL.` },
              input
            )
        )
      ),
      encode: Getter.transform((ref: FileRef) => ref.id)
    })
  )

/**
 * Builds a Drive `q` expression, escaping user-provided strings.
 *
 * @category parsing
 */
export const driveQuery = (parts: {
  readonly text?: string | undefined
  readonly nameOnly?: boolean | undefined
  readonly mimeTypes?: ReadonlyArray<string> | undefined
  readonly folderId?: string | undefined
  readonly trashed?: boolean | undefined
}): string =>
  Arr.getSomes([
    Option.some(`trashed = ${parts.trashed ? "true" : "false"}`),
    nonEmpty(parts.text?.trim()).pipe(
      Option.map(queryLiteral),
      Option.map((literal) =>
        parts.nameOnly ? `name contains ${literal}` : `(name contains ${literal} or fullText contains ${literal})`
      )
    ),
    Option.fromUndefinedOr(parts.mimeTypes).pipe(
      Option.filter(Arr.isReadonlyArrayNonEmpty),
      Option.map((mimeTypes) => `(${mimeTypes.map((m) => `mimeType = ${queryLiteral(m)}`).join(" or ")})`)
    ),
    Option.map(nonEmpty(parts.folderId), (folderId) => `${queryLiteral(folderId)} in parents`)
  ]).join(" and ")

/** `Some` for a present, non-empty string. */
const nonEmpty = (value: string | undefined): Option.Option<string> =>
  Option.fromUndefinedOr(value).pipe(Option.filter((text) => text !== ""))

/** A single-quoted Drive query literal; backslashes and quotes are backslash-escaped. */
const queryLiteral = (value: string): string => `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`

/**
 * Human-readable kind for a file's MIME type.
 *
 * @category rendering
 */
export const kindOf = (mimeType: string): string => Option.getOrElse(Record.get(KIND_NAMES, mimeType), () => mimeType)

const KIND_NAMES: Record<string, string> = {
  [MIME.doc]: "Google Doc",
  [MIME.sheet]: "Google Sheet",
  [MIME.slides]: "Google Slides",
  [MIME.folder]: "Folder"
}

/**
 * One search-result entry.
 *
 * @category rendering
 */
export const formatFileLine = (file: DriveFile): string => {
  const owner = file.owners?.[0]?.emailAddress ?? file.lastModifyingUser?.emailAddress
  return Arr.getSomes([
    Option.some(`- **${file.name}** (${kindOf(file.mimeType)})`),
    Option.some(`  id: ${file.id}`),
    Option.map(nonEmpty(file.modifiedTime), (modified) => `  modified: ${modified}${owner ? ` by ${owner}` : ""}`),
    Option.map(nonEmpty(file.webViewLink), (link) => `  link: ${link}`)
  ]).join("\n")
}

/**
 * Markdown header block describing a file.
 *
 * @category rendering
 */
export const formatFileHeader = (file: DriveFile): string => {
  const who = file.lastModifyingUser?.emailAddress ?? file.lastModifyingUser?.displayName
  return Arr.getSomes([
    Option.some(`# ${file.name}`),
    Option.some(`- Type: ${kindOf(file.mimeType)}`),
    Option.some(`- ID: ${file.id}`),
    Option.map(nonEmpty(file.webViewLink), (link) => `- Link: ${link}`),
    Option.map(nonEmpty(file.modifiedTime), (modified) => `- Modified: ${modified}${who ? ` by ${who}` : ""}`),
    Option.fromUndefinedOr(file.owners).pipe(
      Option.filter(Arr.isReadonlyArrayNonEmpty),
      Option.map((owners) => `- Owner: ${owners.map((o) => o.emailAddress ?? o.displayName).join(", ")}`)
    ),
    Option.map(nonEmpty(file.description), (description) => `- Description: ${description}`)
  ]).join("\n")
}

/**
 * One line per spreadsheet tab with its gid and grid size.
 *
 * @category rendering
 */
export const describeTab = (sheet: SheetTab): string => {
  const g = sheet.properties.gridProperties
  const size = g ? ` — ${g.rowCount ?? "?"} rows × ${g.columnCount ?? "?"} cols` : ""
  return `- ${sheet.properties.title} (gid ${sheet.properties.sheetId})${size}`
}

const cellText = (value: CellValue | undefined): string => value === null || value === undefined ? "" : String(value)

/**
 * Spreadsheet column letter for a zero-based index: 0 → A, 26 → AA.
 *
 * @category rendering
 */
export const columnLetter = (index: number): string => {
  const letter = String.fromCharCode(65 + (index % 26))
  const rest = Math.floor(index / 26) - 1
  return rest >= 0 ? columnLetter(rest) + letter : letter
}

/**
 * Renders rows as a Markdown table. Ragged rows are padded; pipes and newlines are escaped.
 *
 * @category rendering
 */
export const toMarkdownTable = (rows: Rows, options: { readonly headerRow?: boolean | undefined } = {}): string =>
  Arr.match(rows, {
    onEmpty: () => "_(empty range)_",
    onNonEmpty: (rows) => {
      const width = Math.max(...rows.map((r) => r.length), 1)
      const escape = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ")
      const pad = (row: ReadonlyArray<CellValue>) => Arr.makeBy(width, (i) => escape(cellText(row[i])))
      const useHeader = options.headerRow !== false
      const header = useHeader ? pad(rows[0]) : Arr.makeBy(width, columnLetter)
      const body = useHeader ? rows.slice(1) : rows
      return [
        `| ${header.join(" | ")} |`,
        `| ${header.map(() => "---").join(" | ")} |`,
        ...body.map((row) => `| ${pad(row).join(" | ")} |`)
      ].join("\n")
    }
  })

/**
 * Renders rows as RFC 4180 CSV.
 *
 * @category rendering
 */
export const toCsv = (rows: Rows): string => {
  const quote = (s: string) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, "\"\"")}"` : s)
  return rows.map((row) => row.map((c) => quote(cellText(c))).join(",")).join("\n")
}

/**
 * Quotes a sheet title for an A1 range: `My Tab` → `'My Tab'`.
 *
 * @category rendering
 */
export const quoteSheetTitle = (title: string): string =>
  /^[A-Za-z0-9_]+$/.test(title) ? title : `'${title.replace(/'/g, "''")}'`

/**
 * Renders comments with quoted passages and replies.
 *
 * @category rendering
 */
export const formatComments = (comments: ReadonlyArray<DriveComment>): string =>
  Arr.match(comments, {
    onEmpty: () => "_(no comments)_",
    onNonEmpty: (comments) =>
      comments
        .map((c) => {
          const who = c.author?.displayName ?? c.author?.emailAddress ?? "unknown"
          const status = c.resolved ? " [resolved]" : ""
          return [
            `### ${who} — ${c.createdTime ?? ""}${status}`,
            ...Arr.fromOption(
              Option.map(nonEmpty(c.quotedFileContent?.value), (quoted) => `> ${quoted.replace(/\r?\n/g, "\n> ")}`)
            ),
            c.content ?? "",
            ...(c.replies ?? []).map((reply) => {
              const replyWho = reply.author?.displayName ?? reply.author?.emailAddress ?? "unknown"
              const action = reply.action ? ` (${reply.action})` : ""
              return `  - **${replyWho}**${action} ${reply.createdTime ?? ""}: ${reply.content ?? ""}`
            }),
            `  _comment id: ${c.id}_`
          ].join("\n")
        })
        .join("\n\n")
  })

/**
 * A page of a long text.
 *
 * @category models
 */
export interface Page {
  readonly text: string
  readonly truncated: boolean
  readonly total: number
  readonly nextStart?: number | undefined
}

/**
 * Slices `text` for paging. `maxChars` is clamped to at least 1000.
 *
 * @category rendering
 */
export const truncate = (
  text: string,
  options: { readonly startChar?: number | undefined; readonly maxChars?: number | undefined }
): Page => {
  const start = Math.max(options.startChar ?? 0, 0)
  const max = Math.max(options.maxChars ?? 60_000, 1_000)
  const total = text.length
  const truncated = start + max < total
  return { text: text.slice(start, start + max), truncated, total, nextStart: truncated ? start + max : undefined }
}
