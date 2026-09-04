/**
 * Fake `Google` and `GoogleAuth` services for tool tests.
 *
 * The Google fake records every call (method name and arguments) so a test can assert exactly which
 * requests a tool made, and dies on any method the test did not stub, so an unexpected request fails
 * the test loudly instead of returning `undefined`.
 */
import * as Arr from "effect/Array"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as MutableRef from "effect/MutableRef"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as Credential from "../../src/Credential.ts"
import { Google, type Shape } from "../../src/Google.ts"
import { GoogleAuth, type Shape as AuthShape } from "../../src/GoogleAuth.ts"
import { type Shape as SubjectTokenShape, SubjectToken } from "../../src/SubjectToken.ts"

/** One recorded Google call. `args` are the arguments exactly as the tool passed them. */
export interface Call {
  readonly method: keyof Shape
  readonly args: ReadonlyArray<unknown>
}

export interface RecordingGoogle {
  readonly calls: ReadonlyArray<Call>
  readonly layer: Layer.Layer<Google>
}

/** The defect a tool raises when it calls a Google method the test did not stub. */
export class UnexpectedGoogleCall extends Schema.TaggedError<UnexpectedGoogleCall>()("UnexpectedGoogleCall", {
  method: Schema.String
}) {}

/** The Google methods a test chooses to answer; every other method dies with `UnexpectedGoogleCall`. */
export interface Stubs {
  readonly about?: Shape["about"]
  readonly getFile?: Shape["getFile"]
  readonly listFiles?: Shape["listFiles"]
  readonly exportFile?: Shape["exportFile"]
  readonly downloadFile?: Shape["downloadFile"]
  readonly listComments?: Shape["listComments"]
  readonly createComment?: Shape["createComment"]
  readonly getSpreadsheet?: Shape["getSpreadsheet"]
  readonly getValues?: Shape["getValues"]
  readonly updateValues?: Shape["updateValues"]
  readonly appendValues?: Shape["appendValues"]
  readonly appendDocumentText?: Shape["appendDocumentText"]
  readonly createFile?: Shape["createFile"]
  readonly deleteFile?: Shape["deleteFile"]
}

const unexpected = (method: keyof Shape) => Effect.die(new UnexpectedGoogleCall({ method }))

/** A `Google` service whose methods are `impl` (recorded) and whose other methods die when called. */
export const google = (impl: Stubs): RecordingGoogle => {
  const calls = MutableRef.make<ReadonlyArray<Call>>([])
  const record = (method: keyof Shape, args: ReadonlyArray<unknown>) =>
    Effect.sync(() => MutableRef.update(calls, Arr.append({ method, args })))
  const method = <Args extends ReadonlyArray<unknown>, A, E, R>(
    name: keyof Shape,
    target: ((...args: Args) => Effect.Effect<A, E, R>) | undefined
  ) =>
  (...args: Args): Effect.Effect<A, E, R> =>
    record(name, args).pipe(Effect.andThen(target === undefined ? unexpected(name) : target(...args)))
  const shape: Shape = {
    about: record("about", []).pipe(Effect.andThen(impl.about ?? unexpected("about"))),
    getFile: method("getFile", impl.getFile),
    listFiles: method("listFiles", impl.listFiles),
    exportFile: method("exportFile", impl.exportFile),
    downloadFile: method("downloadFile", impl.downloadFile),
    listComments: method("listComments", impl.listComments),
    createComment: method("createComment", impl.createComment),
    getSpreadsheet: method("getSpreadsheet", impl.getSpreadsheet),
    getValues: method("getValues", impl.getValues),
    updateValues: method("updateValues", impl.updateValues),
    appendValues: method("appendValues", impl.appendValues),
    appendDocumentText: method("appendDocumentText", impl.appendDocumentText),
    createFile: method("createFile", impl.createFile),
    deleteFile: method("deleteFile", impl.deleteFile)
  }
  return {
    get calls() {
      return MutableRef.get(calls)
    },
    layer: Layer.succeed(Google)(shape)
  }
}

export const serviceAccount: Credential.ServiceAccount = Credential.Credential.ServiceAccount({
  clientEmail: "robot@example-project.iam.gserviceaccount.com",
  privateKey: Redacted.make("unused"),
  tokenUri: "https://oauth2.googleapis.com/token",
  subject: Option.none()
})

export const delegated: Credential.ServiceAccount = { ...serviceAccount, subject: Option.some("ari@scenesystems.io") }

export const oauth: Credential.OAuthRefresh = Credential.Credential.OAuthRefresh({
  clientId: "client-id.apps.googleusercontent.com",
  clientSecret: Redacted.make("unused"),
  refreshToken: Redacted.make("unused")
})

export const workloadIdentity: Credential.WorkloadIdentity = Credential.Credential.WorkloadIdentity({
  provider: "projects/123456789012/locations/global/workloadIdentityPools/amp-orbs/providers/amp",
  serviceAccountEmail: "amp-google-workspace@example-project.iam.gserviceaccount.com",
  subject: Option.none(),
  subjectToken: Credential.SubjectTokenSource.AmpOrb()
})

export const delegatedWorkloadIdentity: Credential.WorkloadIdentity = {
  ...workloadIdentity,
  subject: Option.some("ari@scenesystems.io")
}

export const noCredentials = new Credential.CredentialError({
  message: [
    "No Google credentials configured.",
    "Set one of:",
    "  - GOOGLE_WORKLOAD_IDENTITY_PROVIDER + GOOGLE_SERVICE_ACCOUNT_EMAIL (keyless; Amp workspace variables), or",
    "  - GOOGLE_OAUTH_CLIENT_ID + GOOGLE_OAUTH_CLIENT_SECRET + GOOGLE_OAUTH_REFRESH_TOKEN (acts as you; personal secrets), or",
    "  - GOOGLE_SERVICE_ACCOUNT_KEY (service account JSON; Amp workspace secret)."
  ].join("\n"),
  hint: "See the google-workspace skill (reference/setup.md) for setup steps."
})

/** One recorded `SubjectToken.get` call. */
export interface SubjectTokenCall {
  readonly source: Credential.SubjectTokenSource
  readonly audience: string
}

export interface RecordingSubjectToken {
  readonly calls: ReadonlyArray<SubjectTokenCall>
  readonly layer: Layer.Layer<SubjectToken>
}

/**
 * A `SubjectToken` that records every request and answers with `reply`: a token, or the error the
 * source would raise.
 */
export const subjectToken = (
  reply: (call: SubjectTokenCall, index: number) => string | Credential.CredentialError
): RecordingSubjectToken =>
  recordingSubjectToken((call, index) => {
    const result = reply(call, index)
    return result instanceof Credential.CredentialError ? Effect.fail(result) : Effect.succeed(Redacted.make(result))
  })

/** The defect raised when a test's `SubjectToken` is consulted although the code under test must not need one. */
export class UnexpectedSubjectTokenCall
  extends Schema.TaggedError<UnexpectedSubjectTokenCall>()("UnexpectedSubjectTokenCall", {
    audience: Schema.String
  })
{}

/** A `SubjectToken` that must not be asked for a token; any `get` dies with `UnexpectedSubjectTokenCall`. */
export const noSubjectToken = (): RecordingSubjectToken =>
  recordingSubjectToken((call) => Effect.die(new UnexpectedSubjectTokenCall({ audience: call.audience })))

const recordingSubjectToken = (
  get: (call: SubjectTokenCall, index: number) => Effect.Effect<Redacted.Redacted, Credential.CredentialError>
): RecordingSubjectToken => {
  const calls = MutableRef.make<ReadonlyArray<SubjectTokenCall>>([])
  const shape: SubjectTokenShape = {
    get: (source, audience) =>
      Effect.suspend(() => {
        const call: SubjectTokenCall = { source, audience }
        const index = MutableRef.get(calls).length
        MutableRef.update(calls, Arr.append(call))
        return get(call, index)
      })
  }
  return {
    get calls() {
      return MutableRef.get(calls)
    },
    layer: Layer.succeed(SubjectToken)(shape)
  }
}

export interface AuthOptions {
  /** Resolved credential, or the error resolving it produces. Default: `serviceAccount`. */
  readonly credential?: Credential.Credential | Credential.CredentialError | undefined
  /** Default: false. */
  readonly readOnly?: boolean | undefined
}

/** A `GoogleAuth` with a fixed credential and read-only flag; the scope follows the flag as in production. */
export const auth = (options: AuthOptions = {}): Layer.Layer<GoogleAuth> => {
  const credential = options.credential ?? serviceAccount
  const readOnly = options.readOnly ?? false
  const shape: AuthShape = {
    credential: credential instanceof Credential.CredentialError ? Effect.fail(credential) : Effect.succeed(credential),
    scope: Effect.succeed(readOnly ? Credential.SCOPE_READ_ONLY : Credential.SCOPE_FULL),
    readOnly: Effect.succeed(readOnly),
    accessToken: Effect.succeed(Redacted.make("unused-token")),
    invalidate: Effect.void
  }
  return Layer.succeed(GoogleAuth)(shape)
}
