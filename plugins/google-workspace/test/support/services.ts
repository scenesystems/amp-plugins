/**
 * Fake `Google` and `GoogleAuth` services for tool tests.
 *
 * The Google fake records every call (method name and arguments) so a test can assert exactly which
 * requests a tool made, and dies on any method the test did not stub, so an unexpected request fails
 * the test loudly instead of returning `undefined`.
 */
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
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

type Method = Exclude<keyof Shape, "about">

const unexpected = (method: keyof Shape) => Effect.die(new Error(`Unexpected Google call: ${method}`))

/** A `Google` service whose methods are `impl` (recorded) and whose other methods die when called. */
export const google = (impl: Partial<Shape>): RecordingGoogle => {
  const calls: Array<Call> = []
  const method = <K extends Method>(name: K): Shape[K] => {
    const target = impl[name]
    return ((...args: Array<never>) => {
      calls.push({ method: name, args })
      return target === undefined ? unexpected(name) : (target as (...a: Array<never>) => unknown)(...args)
    }) as Shape[K]
  }
  const about: Shape["about"] = Effect.suspend(() => {
    calls.push({ method: "about", args: [] })
    return impl.about ?? unexpected("about")
  })
  const shape: Shape = {
    about,
    getFile: method("getFile"),
    listFiles: method("listFiles"),
    exportFile: method("exportFile"),
    downloadFile: method("downloadFile"),
    listComments: method("listComments"),
    createComment: method("createComment"),
    getSpreadsheet: method("getSpreadsheet"),
    getValues: method("getValues"),
    updateValues: method("updateValues"),
    appendValues: method("appendValues"),
    appendDocumentText: method("appendDocumentText"),
    createFile: method("createFile"),
    deleteFile: method("deleteFile")
  }
  return { calls, layer: Layer.succeed(Google)(shape) }
}

export const serviceAccount: Credential.ServiceAccount = {
  _tag: "ServiceAccount",
  clientEmail: "robot@example-project.iam.gserviceaccount.com",
  privateKey: Redacted.make("unused"),
  tokenUri: "https://oauth2.googleapis.com/token",
  subject: Option.none()
}

export const delegated: Credential.ServiceAccount = { ...serviceAccount, subject: Option.some("ari@scenesystems.io") }

export const oauth: Credential.OAuthRefresh = {
  _tag: "OAuthRefresh",
  clientId: "client-id.apps.googleusercontent.com",
  clientSecret: Redacted.make("unused"),
  refreshToken: Redacted.make("unused")
}

export const workloadIdentity: Credential.WorkloadIdentity = {
  _tag: "WorkloadIdentity",
  provider: "projects/123456789012/locations/global/workloadIdentityPools/amp-orbs/providers/amp",
  serviceAccountEmail: "amp-google-workspace@example-project.iam.gserviceaccount.com",
  subject: Option.none(),
  subjectToken: { _tag: "AmpOrb" }
}

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
): RecordingSubjectToken => {
  const calls: Array<SubjectTokenCall> = []
  const shape: SubjectTokenShape = {
    get: (source, audience) =>
      Effect.suspend(() => {
        const call = { source, audience }
        calls.push(call)
        const result = reply(call, calls.length - 1)
        return result instanceof Credential.CredentialError
          ? Effect.fail(result)
          : Effect.succeed(Redacted.make(result))
      })
  }
  return { calls, layer: Layer.succeed(SubjectToken)(shape) }
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
