/**
 * Schemas for the subset of Drive v3, Sheets v4, and Docs v1 payloads the plugin reads.
 * Unknown keys are dropped on decode, so these stay small even as Google adds fields.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema"

/**
 * Google-native MIME types.
 *
 * @since 0.1.0
 * @category constants
 */
export const MIME = {
  doc: "application/vnd.google-apps.document",
  sheet: "application/vnd.google-apps.spreadsheet",
  slides: "application/vnd.google-apps.presentation",
  folder: "application/vnd.google-apps.folder",
  shortcut: "application/vnd.google-apps.shortcut"
} as const

const Person = Schema.Struct({
  emailAddress: Schema.optionalKey(Schema.String),
  displayName: Schema.optionalKey(Schema.String)
})

/**
 * A Drive file resource, restricted to `FILE_FIELDS`.
 *
 * @since 0.1.0
 * @category models
 */
export class DriveFile extends Schema.Class<DriveFile>("DriveFile")({
  id: Schema.String,
  name: Schema.String,
  mimeType: Schema.String,
  modifiedTime: Schema.optionalKey(Schema.String),
  createdTime: Schema.optionalKey(Schema.String),
  webViewLink: Schema.optionalKey(Schema.String),
  owners: Schema.optionalKey(Schema.Array(Person)),
  lastModifyingUser: Schema.optionalKey(Person),
  parents: Schema.optionalKey(Schema.Array(Schema.String)),
  size: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  shortcutDetails: Schema.optionalKey(
    Schema.Struct({
      targetId: Schema.optionalKey(Schema.String),
      targetMimeType: Schema.optionalKey(Schema.String)
    })
  ),
  driveId: Schema.optionalKey(Schema.String)
}) {}

/**
 * The `fields` projection requested for every file read, matching `DriveFile`.
 *
 * @since 0.1.0
 * @category constants
 */
export const FILE_FIELDS =
  "id,name,mimeType,modifiedTime,createdTime,webViewLink,owners(emailAddress,displayName),lastModifyingUser(emailAddress,displayName),parents,size,description,shortcutDetails(targetId,targetMimeType),driveId"

/**
 * @since 0.1.0
 * @category models
 */
export const FileList = Schema.Struct({
  files: Schema.optionalKey(Schema.Array(DriveFile)),
  nextPageToken: Schema.optionalKey(Schema.String)
})

/**
 * @since 0.1.0
 * @category models
 */
export const About = Schema.Struct({
  user: Schema.optionalKey(Person)
})

const CommentReply = Schema.Struct({
  id: Schema.String,
  author: Schema.optionalKey(Person),
  content: Schema.optionalKey(Schema.String),
  action: Schema.optionalKey(Schema.String),
  createdTime: Schema.optionalKey(Schema.String)
})

/**
 * A Drive comment with its replies.
 *
 * @since 0.1.0
 * @category models
 */
export class DriveComment extends Schema.Class<DriveComment>("DriveComment")({
  id: Schema.String,
  author: Schema.optionalKey(Schema.Struct({ ...Person.fields, me: Schema.optionalKey(Schema.Boolean) })),
  content: Schema.optionalKey(Schema.String),
  quotedFileContent: Schema.optionalKey(Schema.Struct({ value: Schema.optionalKey(Schema.String) })),
  resolved: Schema.optionalKey(Schema.Boolean),
  deleted: Schema.optionalKey(Schema.Boolean),
  createdTime: Schema.optionalKey(Schema.String),
  modifiedTime: Schema.optionalKey(Schema.String),
  replies: Schema.optionalKey(Schema.Array(CommentReply))
}) {}

/**
 * The `fields` projection for comment listings, matching `DriveComment`.
 *
 * @since 0.1.0
 * @category constants
 */
export const COMMENT_FIELDS =
  "nextPageToken,comments(id,author(displayName,emailAddress,me),content,quotedFileContent(value),resolved,deleted,createdTime,modifiedTime,replies(id,author(displayName,emailAddress),content,action,createdTime))"

/**
 * @since 0.1.0
 * @category models
 */
export const CommentList = Schema.Struct({
  comments: Schema.optionalKey(Schema.Array(DriveComment)),
  nextPageToken: Schema.optionalKey(Schema.String)
})

/**
 * @since 0.1.0
 * @category models
 */
export const SheetTab = Schema.Struct({
  properties: Schema.Struct({
    sheetId: Schema.Finite,
    title: Schema.String,
    index: Schema.optionalKey(Schema.Finite),
    gridProperties: Schema.optionalKey(
      Schema.Struct({
        rowCount: Schema.optionalKey(Schema.Finite),
        columnCount: Schema.optionalKey(Schema.Finite),
        frozenRowCount: Schema.optionalKey(Schema.Finite)
      })
    )
  })
})

/**
 * @since 0.1.0
 * @category models
 */
export type SheetTab = typeof SheetTab.Type

/**
 * Spreadsheet metadata: title, URL, and tabs.
 *
 * @since 0.1.0
 * @category models
 */
export class Spreadsheet extends Schema.Class<Spreadsheet>("Spreadsheet")({
  spreadsheetId: Schema.String,
  properties: Schema.Struct({ title: Schema.String }),
  spreadsheetUrl: Schema.optionalKey(Schema.String),
  sheets: Schema.Array(SheetTab)
}) {}

/**
 * The `fields` projection for spreadsheet metadata, matching `Spreadsheet`.
 *
 * @since 0.1.0
 * @category constants
 */
export const SPREADSHEET_FIELDS =
  "spreadsheetId,spreadsheetUrl,properties.title,sheets(properties(sheetId,title,index,gridProperties(rowCount,columnCount,frozenRowCount)))"

/**
 * A single cell as returned by (or accepted by) the Sheets values API.
 *
 * @since 0.1.0
 * @category models
 */
export const CellValue = Schema.Union([Schema.String, Schema.Finite, Schema.Boolean, Schema.Null])

/**
 * @since 0.1.0
 * @category models
 */
export type CellValue = typeof CellValue.Type

/**
 * @since 0.1.0
 * @category models
 */
export const Rows = Schema.Array(Schema.Array(CellValue))

/**
 * @since 0.1.0
 * @category models
 */
export type Rows = typeof Rows.Type

/**
 * @since 0.1.0
 * @category models
 */
export const ValueRange = Schema.Struct({
  values: Schema.optionalKey(Rows)
})

/**
 * Result of a Sheets `values.update`.
 *
 * @since 0.1.0
 * @category models
 */
export const UpdateResult = Schema.Struct({
  updatedRange: Schema.optionalKey(Schema.String),
  updatedRows: Schema.optionalKey(Schema.Finite),
  updatedColumns: Schema.optionalKey(Schema.Finite),
  updatedCells: Schema.optionalKey(Schema.Finite)
})

/**
 * Result of a Sheets `values.append`.
 *
 * @since 0.1.0
 * @category models
 */
export const AppendResult = Schema.Struct({
  updates: Schema.optionalKey(UpdateResult)
})

/**
 * The end indexes of a Google Doc body, used to find the append position.
 *
 * @since 0.1.0
 * @category models
 */
export const DocumentBody = Schema.Struct({
  body: Schema.optionalKey(
    Schema.Struct({
      content: Schema.optionalKey(Schema.Array(Schema.Struct({ endIndex: Schema.optionalKey(Schema.Finite) })))
    })
  )
})

/**
 * Error envelope returned by Google APIs on non-2xx responses.
 *
 * @since 0.1.0
 * @category models
 */
export const ErrorBody = Schema.Struct({
  error: Schema.optionalKey(
    Schema.Struct({
      message: Schema.optionalKey(Schema.String),
      status: Schema.optionalKey(Schema.String),
      errors: Schema.optionalKey(Schema.Array(Schema.Struct({ reason: Schema.optionalKey(Schema.String) })))
    })
  )
})

/**
 * OAuth2 token endpoint success body.
 *
 * @since 0.1.0
 * @category models
 */
export const TokenResponse = Schema.Struct({
  access_token: Schema.String,
  expires_in: Schema.optionalKey(Schema.Finite)
})

/**
 * OAuth2 token endpoint error body.
 *
 * @since 0.1.0
 * @category models
 */
export const TokenError = Schema.Struct({
  error: Schema.optionalKey(Schema.String),
  error_description: Schema.optionalKey(Schema.String)
})
