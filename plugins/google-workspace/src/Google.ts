/**
 * Typed wrappers over the Drive v3, Sheets v4, and Docs v1 REST APIs on Effect's `HttpClient`.
 * Every call carries a bearer token from `GoogleAuth`; a 401 invalidates the token and retries once.
 */
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import type { CredentialError } from "./Credential.ts"
import { GoogleAuth } from "./GoogleAuth.ts"
import * as Model from "./Model.ts"

const DRIVE = "https://www.googleapis.com/drive/v3"
const SHEETS = "https://sheets.googleapis.com/v4"
const DOCS = "https://docs.googleapis.com/v1"

/**
 * A non-2xx response from a Google API, or a transport/decoding failure (status 0).
 *
 * @category errors
 */
export class GoogleApiError extends Data.TaggedError("GoogleApiError")<{
  readonly message: string
  readonly status: number
  readonly reason?: string | undefined
}> {}

/**
 * Failures a Google call can produce.
 *
 * @category errors
 */
export type Error = GoogleApiError | CredentialError

/**
 * Service shape.
 *
 * @category models
 */
export interface Shape {
  readonly about: Effect.Effect<typeof Model.About.Type, Error>
  /** Fetches file metadata, following shortcuts to their target. */
  readonly getFile: (fileId: string) => Effect.Effect<Model.DriveFile, Error>
  readonly listFiles: (options: {
    readonly q: string
    readonly pageSize?: number | undefined
    readonly orderBy?: string | undefined
  }) => Effect.Effect<ReadonlyArray<Model.DriveFile>, Error>
  /** Exports a Google-native document (Doc/Slides/Sheet) to `mimeType`. */
  readonly exportFile: (fileId: string, mimeType: string) => Effect.Effect<string, Error>
  /** Downloads a regular (non-Google-native) file's bytes as text. */
  readonly downloadFile: (fileId: string) => Effect.Effect<string, Error>
  readonly listComments: (
    fileId: string,
    options: { readonly includeResolved: boolean }
  ) => Effect.Effect<ReadonlyArray<Model.DriveComment>, Error>
  readonly createComment: (fileId: string, content: string) => Effect.Effect<Model.DriveComment, Error>
  readonly getSpreadsheet: (spreadsheetId: string) => Effect.Effect<Model.Spreadsheet, Error>
  readonly getValues: (spreadsheetId: string, range: string) => Effect.Effect<Model.Rows, Error>
  readonly updateValues: (
    spreadsheetId: string,
    range: string,
    values: Model.Rows
  ) => Effect.Effect<typeof Model.UpdateResult.Type, Error>
  readonly appendValues: (
    spreadsheetId: string,
    range: string,
    values: Model.Rows
  ) => Effect.Effect<typeof Model.AppendResult.Type, Error>
  /** Inserts `text` just before the document's trailing newline. */
  readonly appendDocumentText: (documentId: string, text: string) => Effect.Effect<void, Error>
  /** Creates an empty file (a Google Doc/Sheet when `mimeType` is Google-native) inside `parents`. */
  readonly createFile: (options: {
    readonly name: string
    readonly mimeType: string
    readonly parents: ReadonlyArray<string>
  }) => Effect.Effect<Model.DriveFile, Error>
  /** Permanently deletes a file, bypassing the trash. */
  readonly deleteFile: (fileId: string) => Effect.Effect<void, Error>
}

/**
 * @category services
 */
export class Google extends Context.Service<Google, Shape>()("@scenesystems/google-workspace/Google") {}

const decodeErrorBody = Schema.decodeUnknownOption(Schema.fromJsonString(Model.ErrorBody))

const failWithApiError = (response: HttpClientResponse.HttpClientResponse): Effect.Effect<never, GoogleApiError> =>
  Effect.gen(function*() {
    const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
    const parsed = decodeErrorBody(text)
    const message = Option.flatMap(parsed, (p) => Option.fromUndefinedOr(p.error?.message)).pipe(
      Option.getOrElse(() => text.slice(0, 500) || response.request.url)
    )
    const reason = Option.flatMap(
      parsed,
      (p) => Option.fromUndefinedOr(p.error?.errors?.[0]?.reason ?? p.error?.status)
    )
    return yield* new GoogleApiError({ message, status: response.status, reason: Option.getOrUndefined(reason) })
  })

const encode = encodeURIComponent

/**
 * Builds the service from `GoogleAuth` and an `HttpClient`.
 *
 * @category constructors
 */
export const make: Effect.Effect<Shape, never, GoogleAuth | HttpClient.HttpClient> = Effect.gen(function*() {
  const auth = yield* GoogleAuth
  const client = yield* HttpClient.HttpClient

  const sendOnce = (
    request: HttpClientRequest.HttpClientRequest
  ): Effect.Effect<HttpClientResponse.HttpClientResponse, Error> =>
    Effect.gen(function*() {
      const token = yield* auth.accessToken
      return yield* client.execute(request.pipe(HttpClientRequest.bearerToken(token))).pipe(
        Effect.mapError((error) => new GoogleApiError({ message: error.message, status: 0, reason: error._tag }))
      )
    })

  const send = (
    request: HttpClientRequest.HttpClientRequest
  ): Effect.Effect<HttpClientResponse.HttpClientResponse, Error> =>
    sendOnce(request).pipe(
      // One retry on 401: the cached token may have been revoked or expired early.
      Effect.filterOrElse(
        (response) => response.status !== 401,
        () => Effect.andThen(auth.invalidate, sendOnce(request))
      ),
      Effect.filterOrElse((response) => response.status >= 200 && response.status < 300, failWithApiError)
    )

  const json = <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S) => {
    const decode = Schema.decodeUnknownEffect(schema)
    return (request: HttpClientRequest.HttpClientRequest): Effect.Effect<S["Type"], Error> =>
      Effect.gen(function*() {
        const response = yield* send(request)
        const body = yield* response.json.pipe(
          Effect.mapError((error) => new GoogleApiError({ message: error.message, status: 0, reason: "InvalidJson" }))
        )
        return yield* decode(body).pipe(
          Effect.mapError((error) =>
            new GoogleApiError({ message: `Unexpected response shape: ${error.message}`, status: 0, reason: "Decode" })
          )
        )
      })
  }

  const text = (request: HttpClientRequest.HttpClientRequest): Effect.Effect<string, Error> =>
    Effect.gen(function*() {
      const response = yield* send(request)
      return yield* response.text.pipe(
        Effect.mapError((error) => new GoogleApiError({ message: error.message, status: 0, reason: "Body" }))
      )
    })

  const getFile: Shape["getFile"] = (fileId) =>
    Effect.gen(function*() {
      const file = yield* json(Model.DriveFile)(
        HttpClientRequest.get(`${DRIVE}/files/${encode(fileId)}`, {
          urlParams: { fields: Model.FILE_FIELDS, supportsAllDrives: "true" }
        })
      )
      const target = file.shortcutDetails?.targetId
      return file.mimeType === Model.MIME.shortcut && target !== undefined ? yield* getFile(target) : file
    })

  const listComments: Shape["listComments"] = (fileId, { includeResolved }) => {
    const page = (pageToken: string | undefined): Effect.Effect<typeof Model.CommentList.Type, Error> =>
      json(Model.CommentList)(
        HttpClientRequest.get(`${DRIVE}/files/${encode(fileId)}/comments`, {
          urlParams: { pageSize: 100, fields: Model.COMMENT_FIELDS, pageToken }
        })
      )
    const collect = (
      pageToken: string | undefined,
      acc: ReadonlyArray<Model.DriveComment>
    ): Effect.Effect<ReadonlyArray<Model.DriveComment>, Error> =>
      Effect.flatMap(page(pageToken), (result) => {
        const all = [...acc, ...(result.comments ?? [])]
        return result.nextPageToken === undefined ? Effect.succeed(all) : collect(result.nextPageToken, all)
      })
    return Effect.map(
      collect(undefined, []),
      (comments) => comments.filter((c) => c.deleted !== true && (includeResolved || c.resolved !== true))
    )
  }

  const getDocumentEndIndex = (documentId: string) =>
    json(Model.DocumentBody)(
      HttpClientRequest.get(`${DOCS}/documents/${encode(documentId)}`, {
        urlParams: { fields: "body(content(endIndex))" }
      })
    ).pipe(
      Effect.map((doc) => {
        const content = doc.body?.content ?? []
        const last = content[content.length - 1]
        // The body always ends with a newline that cannot be written past; insert before it.
        return Math.max((last?.endIndex ?? 2) - 1, 1)
      })
    )

  return Google.of({
    about: json(Model.About)(
      HttpClientRequest.get(`${DRIVE}/about`, { urlParams: { fields: "user(emailAddress,displayName)" } })
    ),

    getFile,

    listFiles: ({ orderBy, pageSize, q }) =>
      json(Model.FileList)(
        HttpClientRequest.get(`${DRIVE}/files`, {
          urlParams: {
            q,
            pageSize: Math.min(Math.max(pageSize ?? 25, 1), 100),
            fields: `nextPageToken,files(${Model.FILE_FIELDS})`,
            supportsAllDrives: "true",
            includeItemsFromAllDrives: "true",
            corpora: "allDrives",
            orderBy: orderBy ?? "modifiedTime desc"
          }
        })
      ).pipe(Effect.map((result) => result.files ?? [])),

    exportFile: (fileId, mimeType) =>
      text(HttpClientRequest.get(`${DRIVE}/files/${encode(fileId)}/export`, { urlParams: { mimeType } })),

    downloadFile: (fileId) =>
      text(
        HttpClientRequest.get(`${DRIVE}/files/${encode(fileId)}`, {
          urlParams: { alt: "media", supportsAllDrives: "true" }
        })
      ),

    listComments,

    createComment: (fileId, content) =>
      json(Model.DriveComment)(
        HttpClientRequest.post(`${DRIVE}/files/${encode(fileId)}/comments`, {
          urlParams: { fields: "id,content,createdTime,author(displayName,emailAddress)" }
        }).pipe(HttpClientRequest.bodyJsonUnsafe({ content }))
      ),

    getSpreadsheet: (spreadsheetId) =>
      json(Model.Spreadsheet)(
        HttpClientRequest.get(`${SHEETS}/spreadsheets/${encode(spreadsheetId)}`, {
          urlParams: { fields: Model.SPREADSHEET_FIELDS }
        })
      ),

    getValues: (spreadsheetId, range) =>
      json(Model.ValueRange)(
        HttpClientRequest.get(`${SHEETS}/spreadsheets/${encode(spreadsheetId)}/values/${encode(range)}`, {
          urlParams: {
            valueRenderOption: "FORMATTED_VALUE",
            dateTimeRenderOption: "FORMATTED_STRING",
            majorDimension: "ROWS"
          }
        })
      ).pipe(Effect.map((result) => result.values ?? [])),

    updateValues: (spreadsheetId, range, values) =>
      json(Model.UpdateResult)(
        HttpClientRequest.put(`${SHEETS}/spreadsheets/${encode(spreadsheetId)}/values/${encode(range)}`, {
          urlParams: { valueInputOption: "USER_ENTERED" }
        }).pipe(HttpClientRequest.bodyJsonUnsafe({ range, majorDimension: "ROWS", values }))
      ),

    appendValues: (spreadsheetId, range, values) =>
      json(Model.AppendResult)(
        HttpClientRequest.post(`${SHEETS}/spreadsheets/${encode(spreadsheetId)}/values/${encode(range)}:append`, {
          urlParams: { valueInputOption: "USER_ENTERED", insertDataOption: "INSERT_ROWS" }
        }).pipe(HttpClientRequest.bodyJsonUnsafe({ range, majorDimension: "ROWS", values }))
      ),

    appendDocumentText: (documentId, text_) =>
      Effect.gen(function*() {
        const index = yield* getDocumentEndIndex(documentId)
        yield* send(
          HttpClientRequest.post(`${DOCS}/documents/${encode(documentId)}:batchUpdate`).pipe(
            HttpClientRequest.bodyJsonUnsafe({ requests: [{ insertText: { location: { index }, text: text_ } }] })
          )
        )
      }),

    createFile: ({ mimeType, name, parents }) =>
      json(Model.DriveFile)(
        HttpClientRequest.post(`${DRIVE}/files`, {
          urlParams: { fields: Model.FILE_FIELDS, supportsAllDrives: "true" }
        }).pipe(HttpClientRequest.bodyJsonUnsafe({ name, mimeType, parents }))
      ),

    deleteFile: (fileId) =>
      Effect.asVoid(
        send(HttpClientRequest.delete(`${DRIVE}/files/${encode(fileId)}`, { urlParams: { supportsAllDrives: "true" } }))
      )
  })
})

/**
 * @category layers
 */
export const layer: Layer.Layer<Google, never, GoogleAuth | HttpClient.HttpClient> = Layer.effect(Google)(make)
