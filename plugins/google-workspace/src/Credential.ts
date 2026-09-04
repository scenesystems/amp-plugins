/**
 * Credential resolution from the environment.
 *
 * Two credential kinds are supported, both read from environment variables so that
 * Amp workspace/project/personal secrets flow into orbs and local shells alike:
 *
 *   1. OAuth refresh token (acts as a specific person):
 *        GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REFRESH_TOKEN
 *   2. Service account (acts as a robot; share files with its email):
 *        GOOGLE_SERVICE_ACCOUNT_KEY            (full JSON key as a string)
 *        GOOGLE_SERVICE_ACCOUNT_KEY_FILE       (path to the JSON key)
 *        GOOGLE_APPLICATION_CREDENTIALS        (standard Google env var; path to the JSON key)
 *      Optional domain-wide delegation:
 *        GOOGLE_IMPERSONATE_USER = <email> | amp-user
 *
 * GOOGLE_WORKSPACE_READ_ONLY=1 requests the read-only Drive scope and disables write tools.
 *
 * When both kinds are configured, the OAuth refresh token wins because it is the more
 * specific (per-person) credential.
 *
 * @since 0.1.0
 */
import * as Config from "effect/Config"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"

/**
 * Full Drive scope.
 *
 * @since 0.1.0
 * @category constants
 */
export const SCOPE_FULL = "https://www.googleapis.com/auth/drive"

/**
 * Read-only Drive scope.
 *
 * @since 0.1.0
 * @category constants
 */
export const SCOPE_READ_ONLY = "https://www.googleapis.com/auth/drive.readonly"

const SETUP_HINT = "See the google-workspace skill (reference/setup.md) for setup steps."

/**
 * Missing, malformed, or rejected Google credentials.
 *
 * @since 0.1.0
 * @category errors
 */
export class CredentialError extends Data.TaggedError("CredentialError")<{
  readonly message: string
  readonly hint?: string | undefined
}> {}

/**
 * A service account key, optionally impersonating `subject` through domain-wide delegation.
 *
 * @since 0.1.0
 * @category models
 */
export interface ServiceAccount {
  readonly _tag: "ServiceAccount"
  readonly clientEmail: string
  readonly privateKey: Redacted.Redacted
  readonly tokenUri: string
  readonly subject: Option.Option<string>
}

/**
 * An OAuth client plus a user's refresh token.
 *
 * @since 0.1.0
 * @category models
 */
export interface OAuthRefresh {
  readonly _tag: "OAuthRefresh"
  readonly clientId: string
  readonly clientSecret: Redacted.Redacted
  readonly refreshToken: Redacted.Redacted
}

/**
 * @since 0.1.0
 * @category models
 */
export type Credential = ServiceAccount | OAuthRefresh

/**
 * Human-readable identity of a credential, for whoami/diagnostics. Never includes secrets.
 *
 * @since 0.1.0
 * @category rendering
 */
export const describe = (credential: Credential): string => {
  if (credential._tag === "OAuthRefresh") return `OAuth user credential (client ${credential.clientId})`
  return Option.match(credential.subject, {
    onNone: () => `service account ${credential.clientEmail}`,
    onSome: (subject) => `service account ${credential.clientEmail} impersonating ${subject}`
  })
}

/**
 * The identity Google evaluates permissions against, for share-with-this hints.
 *
 * @since 0.1.0
 * @category rendering
 */
export const identity = (credential: Credential): string =>
  credential._tag === "OAuthRefresh"
    ? "the OAuth user"
    : Option.getOrElse(credential.subject, () => credential.clientEmail)

/**
 * Whether `GOOGLE_WORKSPACE_READ_ONLY` is set to a truthy value.
 *
 * @since 0.1.0
 * @category config
 */
export const readOnly: Config.Config<boolean> = Config.boolean("GOOGLE_WORKSPACE_READ_ONLY").pipe(
  Config.withDefault(false)
)

/**
 * The Drive scope to request: read-only when `GOOGLE_WORKSPACE_READ_ONLY` is set.
 *
 * @since 0.1.0
 * @category config
 */
export const scope: Config.Config<string> = Config.map(readOnly, (ro) => ro ? SCOPE_READ_ONLY : SCOPE_FULL)

const optionalString = (name: string) =>
  Config.string(name).pipe(
    Config.map((s) => s.trim()),
    Config.option,
    Config.map(Option.filter((s) => s !== ""))
  )

const optionalRedacted = (name: string) =>
  Config.redacted(name).pipe(
    Config.map((r) => Redacted.make(Redacted.value(r).trim())),
    Config.option,
    Config.map(Option.filter((r) => Redacted.value(r) !== ""))
  )

const ServiceAccountKey = Schema.fromJsonString(
  Schema.Struct({
    client_email: Schema.String,
    private_key: Schema.String,
    token_uri: Schema.optionalKey(Schema.String)
  })
)
const decodeKey = Schema.decodeUnknownEffect(ServiceAccountKey)

const oauthEnv = Config.all({
  refreshToken: optionalRedacted("GOOGLE_OAUTH_REFRESH_TOKEN"),
  clientId: optionalString("GOOGLE_OAUTH_CLIENT_ID"),
  clientSecret: optionalRedacted("GOOGLE_OAUTH_CLIENT_SECRET")
})

const serviceAccountEnv = Config.all({
  inlineKey: optionalRedacted("GOOGLE_SERVICE_ACCOUNT_KEY"),
  keyFile: optionalString("GOOGLE_SERVICE_ACCOUNT_KEY_FILE"),
  keyFileFallback: optionalString("GOOGLE_APPLICATION_CREDENTIALS"),
  impersonate: optionalString("GOOGLE_IMPERSONATE_USER")
})

const configError = (error: { readonly message: string }) =>
  new CredentialError({ message: `Invalid Google credential configuration: ${error.message}`, hint: SETUP_HINT })

const readKeyFile = (path: string): Effect.Effect<Redacted.Redacted, CredentialError> =>
  Effect.tryPromise({
    try: () => Bun.file(path).text(),
    catch: (error) =>
      new CredentialError({
        message: `Cannot read service account key file ${path}: ${
          error instanceof Error ? error.message : String(error)
        }`
      })
  }).pipe(Effect.map(Redacted.make))

/**
 * Options for resolving a credential.
 *
 * @since 0.1.0
 * @category models
 */
export interface ResolveOptions {
  /** Email of the current Amp user; used when `GOOGLE_IMPERSONATE_USER=amp-user`. */
  readonly ampUserEmail: Option.Option<string>
}

/**
 * Resolves the credential from the active `ConfigProvider` (the process environment by default).
 * Fails with `CredentialError` when nothing is configured or the configuration is inconsistent.
 *
 * @since 0.1.0
 * @category constructors
 */
export const resolve = (options: ResolveOptions): Effect.Effect<Credential, CredentialError> =>
  Effect.gen(function*() {
    const oauth = yield* Effect.mapError(oauthEnv, configError)
    if (Option.isSome(oauth.refreshToken)) {
      if (Option.isNone(oauth.clientId) || Option.isNone(oauth.clientSecret)) {
        return yield* new CredentialError({
          message:
            "GOOGLE_OAUTH_REFRESH_TOKEN is set but GOOGLE_OAUTH_CLIENT_ID and/or GOOGLE_OAUTH_CLIENT_SECRET are missing.",
          hint: SETUP_HINT
        })
      }
      return {
        _tag: "OAuthRefresh",
        clientId: oauth.clientId.value,
        clientSecret: oauth.clientSecret.value,
        refreshToken: oauth.refreshToken.value
      } satisfies OAuthRefresh
    }

    const sa = yield* Effect.mapError(serviceAccountEnv, configError)
    const keyPath = Option.orElse(sa.keyFile, () => sa.keyFileFallback)
    const json = Option.isSome(sa.inlineKey)
      ? sa.inlineKey.value
      : Option.isSome(keyPath)
      ? yield* readKeyFile(keyPath.value)
      : yield* new CredentialError({
        message: [
          "No Google credentials configured.",
          "Set one of:",
          "  - GOOGLE_SERVICE_ACCOUNT_KEY (service account JSON) as an Amp workspace secret, or",
          "  - GOOGLE_OAUTH_CLIENT_ID + GOOGLE_OAUTH_CLIENT_SECRET + GOOGLE_OAUTH_REFRESH_TOKEN as personal secrets."
        ].join("\n"),
        hint: SETUP_HINT
      })

    const key = yield* decodeKey(Redacted.value(json)).pipe(
      Effect.mapError(() =>
        new CredentialError({
          message: "Service account key is not valid JSON with \"client_email\" and \"private_key\".",
          hint:
            "Store the downloaded key file verbatim: amp secrets set --workspace GOOGLE_SERVICE_ACCOUNT_KEY --secret --data-file key.json"
        })
      )
    )

    const subject: Option.Option<string> = Option.isNone(sa.impersonate)
      ? Option.none()
      : sa.impersonate.value.toLowerCase() === "amp-user"
      ? Option.isSome(options.ampUserEmail)
        ? options.ampUserEmail
        : yield* new CredentialError({
          message: "GOOGLE_IMPERSONATE_USER=amp-user but the Amp user email is unavailable (not signed in?)."
        })
      : sa.impersonate

    return {
      _tag: "ServiceAccount",
      clientEmail: key.client_email,
      privateKey: Redacted.make(key.private_key),
      tokenUri: key.token_uri ?? "https://oauth2.googleapis.com/token",
      subject
    } satisfies ServiceAccount
  })
