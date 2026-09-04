/**
 * Pure helpers: file reference parsing, Drive query building, and Markdown rendering.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Getter from "effect/SchemaGetter"
import * as Issue from "effect/SchemaIssue"
import type { CellValue, DriveComment, DriveFile, Rows, SheetTab } from "./Model.ts"
import { MIME } from "./Model.ts"

/**
 * A resolved Drive file reference: the file ID plus the sheet tab `gid` when the URL carried one.
 *
 * @since 0.1.0
 * @category models
 */
export interface FileRef {
  readonly id: string
  readonly gid?: number
}

const fileRef = (id: string, gid: number | undefined): FileRef => gid === undefined ? { id } : { id, gid }

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
 * @since 0.1.0
 * @category parsing
 */
export const parseFileRef = (input: string): Option.Option<FileRef> => {
  const raw = input.trim()
  if (raw === "") return Option.none()
  if (!/^https?:\/\//i.test(raw)) {
    return ID_PATTERN.test(raw) ? Option.some({ id: raw }) : Option.none()
  }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return Option.none()
  }
  const gidMatch = /gid=(\d+)/.exec(url.hash) ?? /gid=(\d+)/.exec(url.search)
  const gid = gidMatch ? Number(gidMatch[1]) : undefined
  for (const pattern of PATH_PATTERNS) {
    const match = pattern.exec(url.pathname)
    if (match) return Option.some(fileRef(match[1]!, gid))
  }
  const idParam = url.searchParams.get("id")
  return idParam ? Option.some(fileRef(idParam, gid)) : Option.none()
}

const FileRefStruct = Schema.Struct({
  id: Schema.String,
  gid: Schema.optionalKey(Schema.Finite)
})

/**
 * Tool-input schema for a file: encoded as a string (ID or URL), decoded to a `FileRef`.
 * Invalid references fail decoding with a message the agent can act on.
 *
 * The description is attached to the string side, which is what `Tool.toInputSchema` turns into
 * JSON Schema; annotating the transformation itself would not reach the agent.
 *
 * @since 0.1.0
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
 * @since 0.1.0
 * @category parsing
 */
export const driveQuery = (parts: {
  readonly text?: string | undefined
  readonly nameOnly?: boolean | undefined
  readonly mimeTypes?: ReadonlyArray<string> | undefined
  readonly folderId?: string | undefined
  readonly trashed?: boolean | undefined
}): string => {
  const clauses = [`trashed = ${parts.trashed ? "true" : "false"}`]
  const text = parts.text?.trim()
  if (text) {
    const escaped = text.replace(/\\/g, "\\\\").replace(/'/g, "\\'")
    clauses.push(
      parts.nameOnly ? `name contains '${escaped}'` : `(name contains '${escaped}' or fullText contains '${escaped}')`
    )
  }
  if (parts.mimeTypes && parts.mimeTypes.length > 0) {
    clauses.push(`(${parts.mimeTypes.map((m) => `mimeType = '${m}'`).join(" or ")})`)
  }
  if (parts.folderId) {
    clauses.push(`'${parts.folderId.replace(/'/g, "\\'")}' in parents`)
  }
  return clauses.join(" and ")
}

/**
 * Human-readable kind for a file's MIME type.
 *
 * @since 0.1.0
 * @category rendering
 */
export const kindOf = (file: Pick<DriveFile, "mimeType">): string => {
  switch (file.mimeType) {
    case MIME.doc:
      return "Google Doc"
    case MIME.sheet:
      return "Google Sheet"
    case MIME.slides:
      return "Google Slides"
    case MIME.folder:
      return "Folder"
    default:
      return file.mimeType
  }
}

/**
 * One search-result entry.
 *
 * @since 0.1.0
 * @category rendering
 */
export const formatFileLine = (file: DriveFile): string => {
  const owner = file.owners?.[0]?.emailAddress ?? file.lastModifyingUser?.emailAddress
  return [
    `- **${file.name}** (${kindOf(file)})`,
    `  id: ${file.id}`,
    file.modifiedTime ? `  modified: ${file.modifiedTime}${owner ? ` by ${owner}` : ""}` : undefined,
    file.webViewLink ? `  link: ${file.webViewLink}` : undefined
  ].filter((line) => line !== undefined).join("\n")
}

/**
 * Markdown header block describing a file.
 *
 * @since 0.1.0
 * @category rendering
 */
export const formatFileHeader = (file: DriveFile): string => {
  const lines = [`# ${file.name}`, `- Type: ${kindOf(file)}`, `- ID: ${file.id}`]
  if (file.webViewLink) lines.push(`- Link: ${file.webViewLink}`)
  if (file.modifiedTime) {
    const who = file.lastModifyingUser?.emailAddress ?? file.lastModifyingUser?.displayName
    lines.push(`- Modified: ${file.modifiedTime}${who ? ` by ${who}` : ""}`)
  }
  if (file.owners && file.owners.length > 0) {
    lines.push(`- Owner: ${file.owners.map((o) => o.emailAddress ?? o.displayName).join(", ")}`)
  }
  if (file.description) lines.push(`- Description: ${file.description}`)
  return lines.join("\n")
}

/**
 * One line per spreadsheet tab with its gid and grid size.
 *
 * @since 0.1.0
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
 * @since 0.1.0
 * @category rendering
 */
export const columnLetter = (index: number): string => {
  let n = index
  let out = ""
  do {
    out = String.fromCharCode(65 + (n % 26)) + out
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return out
}

/**
 * Renders rows as a Markdown table. Ragged rows are padded; pipes and newlines are escaped.
 *
 * @since 0.1.0
 * @category rendering
 */
export const toMarkdownTable = (rows: Rows, options: { readonly headerRow?: boolean | undefined } = {}): string => {
  if (rows.length === 0) return "_(empty range)_"
  const width = Math.max(...rows.map((r) => r.length), 1)
  const escape = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ")
  const pad = (row: ReadonlyArray<CellValue>) => Array.from({ length: width }, (_, i) => escape(cellText(row[i])))
  const useHeader = options.headerRow !== false
  const header = useHeader ? pad(rows[0]!) : Array.from({ length: width }, (_, i) => columnLetter(i))
  const body = useHeader ? rows.slice(1) : rows
  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...body.map((row) => `| ${pad(row).join(" | ")} |`)
  ].join("\n")
}

/**
 * Renders rows as RFC 4180 CSV.
 *
 * @since 0.1.0
 * @category rendering
 */
export const toCsv = (rows: Rows): string => {
  const quote = (s: string) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, "\"\"")}"` : s)
  return rows.map((row) => row.map((c) => quote(cellText(c))).join(",")).join("\n")
}

/**
 * Quotes a sheet title for an A1 range: `My Tab` → `'My Tab'`.
 *
 * @since 0.1.0
 * @category rendering
 */
export const quoteSheetTitle = (title: string): string =>
  /^[A-Za-z0-9_]+$/.test(title) ? title : `'${title.replace(/'/g, "''")}'`

/**
 * Renders comments with quoted passages and replies.
 *
 * @since 0.1.0
 * @category rendering
 */
export const formatComments = (comments: ReadonlyArray<DriveComment>): string => {
  if (comments.length === 0) return "_(no comments)_"
  return comments
    .map((c) => {
      const who = c.author?.displayName ?? c.author?.emailAddress ?? "unknown"
      const status = c.resolved ? " [resolved]" : ""
      const lines = [`### ${who} — ${c.createdTime ?? ""}${status}`]
      if (c.quotedFileContent?.value) {
        lines.push(`> ${c.quotedFileContent.value.replace(/\r?\n/g, "\n> ")}`)
      }
      lines.push(c.content ?? "")
      for (const reply of c.replies ?? []) {
        const replyWho = reply.author?.displayName ?? reply.author?.emailAddress ?? "unknown"
        const action = reply.action ? ` (${reply.action})` : ""
        lines.push(`  - **${replyWho}**${action} ${reply.createdTime ?? ""}: ${reply.content ?? ""}`)
      }
      lines.push(`  _comment id: ${c.id}_`)
      return lines.join("\n")
    })
    .join("\n\n")
}

/**
 * A page of a long text.
 *
 * @since 0.1.0
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
 * @since 0.1.0
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
