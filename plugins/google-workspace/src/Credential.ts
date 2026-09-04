/**
 * Credential resolution from the environment.
 *
 * Three credential kinds are supported, all read from environment variables so that
 * Amp workspace/project/personal secrets flow into orbs and local shells alike:
 *
 *   1. OAuth refresh token (acts as a specific person):
 *        GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REFRESH_TOKEN
 *   2. Workload identity (keyless; the orb's Amp OIDC token is exchanged for a token of a
 *      service account, so nothing long-lived is stored anywhere):
 *        GOOGLE_WORKLOAD_IDENTITY_PROVIDER     projects/<number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>
 *        GOOGLE_SERVICE_ACCOUNT_EMAIL          the service account to impersonate
 *        GOOGLE_WORKLOAD_IDENTITY_TOKEN_FILE   optional: read the OIDC token from a file instead of `amp orb id-token`
 *   3. Service account key (acts as a robot; share files with its email):
 *        GOOGLE_SERVICE_ACCOUNT_KEY            (full JSON key as a string)
 *        GOOGLE_SERVICE_ACCOUNT_KEY_FILE       (path to the JSON key)
 *        GOOGLE_APPLICATION_CREDENTIALS        (standard Google env var; path to the JSON key)
 *
 * Kinds 2 and 3 accept optional domain-wide delegation:
 *        GOOGLE_IMPERSONATE_USER = <email> | amp-user
 *
 * GOOGLE_WORKSPACE_READ_ONLY=1 requests the read-only Drive scope and disables write tools.
 *
 * Precedence when several kinds are configured: OAuth (the per-person credential, normally a
 * personal secret) over workload identity (keyless, normally workspace or project variables) over
 * a key (the fallback for organizations that cannot use federation).
 */
import * as Config from "effect/Config"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Match from "effect/Match"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as Getter from "effect/SchemaGetter"

/**
 * Full Drive scope.
 *
 * @category constants
 */
export const SCOPE_FULL = "https://www.googleapis.com/auth/drive"

/**
 * Read-only Drive scope.
 *
 * @category constants
 */
export const SCOPE_READ_ONLY = "https://www.googleapis.com/auth/drive.readonly"

const SETUP_HINT = "See the google-workspace skill (reference/setup.md) for setup steps."

/**
 * Missing, malformed, or rejected Google credentials.
 *
 * @category errors
 */
export class CredentialError extends Data.TaggedError("CredentialError")<{
  readonly message: string
  readonly hint?: string | undefined
}> {}

/**
 * Where the external OIDC token for workload identity federation comes from.
 *
 * @category models
 */
export type SubjectTokenSource = Data.TaggedEnum<{
  /** `amp orb id-token --audience <audience>`; only works inside an Amp orb. */
  AmpOrb: {}
  /** A file holding one OIDC token (the shape of Google's `credential_source.file`), e.g. from CI. */
  File: { readonly path: string }
}>

/**
 * Constructors and matchers for {@link SubjectTokenSource}.
 *
 * @category constructors
 */
export const SubjectTokenSource = Data.taggedEnum<SubjectTokenSource>()

/**
 * The three ways the plugin can authenticate to Google.
 *
 * @category models
 */
export type Credential = Data.TaggedEnum<{
  /** An OAuth client plus a user's refresh token. */
  OAuthRefresh: {
    readonly clientId: string
    readonly clientSecret: Redacted.Redacted
    readonly refreshToken: Redacted.Redacted
  }
  /**
   * Keyless federation: an external OIDC token is exchanged at Google STS and used to impersonate
   * `serviceAccountEmail`, optionally acting as `subject` through domain-wide delegation.
   */
  WorkloadIdentity: {
    /** `projects/<number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>` */
    readonly provider: string
    readonly serviceAccountEmail: string
    readonly subject: Option.Option<string>
    readonly subjectToken: SubjectTokenSource
  }
  /** A service account key, optionally impersonating `subject` through domain-wide delegation. */
  ServiceAccount: {
    readonly clientEmail: string
    readonly privateKey: Redacted.Redacted
    readonly tokenUri: string
    readonly subject: Option.Option<string>
  }
}>

/**
 * Constructors and matchers for {@link Credential}.
 *
 * @category constructors
 */
export const Credential = Data.taggedEnum<Credential>()

/**
 * @category models
 */
export type OAuthRefresh = Data.TaggedEnum.Value<Credential, "OAuthRefresh">

/**
 * @category models
 */
export type WorkloadIdentity = Data.TaggedEnum.Value<Credential, "WorkloadIdentity">

/**
 * @category models
 */
export type ServiceAccount = Data.TaggedEnum.Value<Credential, "ServiceAccount">

/**
 * The `audience` the external OIDC token must carry: Google's default allowed audience for a
 * provider that was created without `--allowed-audiences`.
 *
 * @category workload identity
 */
export const oidcAudience = (credential: WorkloadIdentity): string =>
  `https://iam.googleapis.com/${credential.provider}`

/**
 * The `audience` field of the STS exchange request: the provider's full resource name.
 *
 * @category workload identity
 */
export const stsAudience = (credential: WorkloadIdentity): string => `//iam.googleapis.com/${credential.provider}`

/**
 * Human-readable identity of a credential, for whoami/diagnostics. Never includes secrets.
 *
 * @category rendering
 */
export const describe = (credential: Credential): string =>
  Match.valueTags(credential, {
    OAuthRefresh: (c) => `OAuth user credential (client ${c.clientId})`,
    WorkloadIdentity: (c) => withSubject(`workload identity for service account ${c.serviceAccountEmail}`, c.subject),
    ServiceAccount: (c) => withSubject(`service account ${c.clientEmail}`, c.subject)
  })

const withSubject = (base: string, subject: Option.Option<string>): string =>
  Option.match(subject, { onNone: () => base, onSome: (s) => `${base} impersonating ${s}` })

/**
 * The service account a robot credential acts as, when it is not impersonating a person. This is
 * the email files must be shared with; `None` for credentials that act as a person.
 *
 * @category rendering
 */
export const robotEmail = (credential: Credential): Option.Option<string> =>
  Match.valueTags(credential, {
    OAuthRefresh: () => Option.none(),
    WorkloadIdentity: (c) => Option.isSome(c.subject) ? Option.none() : Option.some(c.serviceAccountEmail),
    ServiceAccount: (c) => Option.isSome(c.subject) ? Option.none() : Option.some(c.clientEmail)
  })

/**
 * The identity Google evaluates permissions against, for share-with-this hints.
 *
 * @category rendering
 */
export const identity = (credential: Credential): string =>
  Match.valueTags(credential, {
    OAuthRefresh: () => "the OAuth user",
    WorkloadIdentity: (c) => Option.getOrElse(c.subject, () => c.serviceAccountEmail),
    ServiceAccount: (c) => Option.getOrElse(c.subject, () => c.clientEmail)
  })

const optionalString = (name: string) =>
  Config.string(name).pipe(
    Config.map((s) => s.trim()),
    Config.option,
    Config.map(Option.filter((s) => s !== ""))
  )

const READ_ONLY = "GOOGLE_WORKSPACE_READ_ONLY"
// Decoded through a struct so a bad value reports the variable name, like `Config.boolean` does.
const decodeFlag = Schema.decodeUnknownEffect(Schema.Struct({ [READ_ONLY]: Config.Boolean }))

/**
 * Whether `GOOGLE_WORKSPACE_READ_ONLY` is set to a truthy value (`true`, `yes`, `on`, `1`, `y`).
 * Unset or blank means `false`; any other value is a configuration error.
 *
 * @category config
 */
export const readOnly: Config.Config<boolean> = optionalString(READ_ONLY).pipe(
  Config.mapOrFail(
    Option.match({
      onNone: () => Effect.succeed(false),
      onSome: (flag) =>
        decodeFlag({ [READ_ONLY]: flag }).pipe(
          Effect.map((decoded) => decoded[READ_ONLY]),
          Effect.mapError((issue) => new Config.ConfigError(issue))
        )
    })
  )
)

/**
 * The Drive scope to request: read-only when `GOOGLE_WORKSPACE_READ_ONLY` is set.
 *
 * @category config
 */
export const scope: Config.Config<string> = Config.map(readOnly, (ro) => ro ? SCOPE_READ_ONLY : SCOPE_FULL)

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

const workloadIdentityEnv = Config.all({
  provider: optionalString("GOOGLE_WORKLOAD_IDENTITY_PROVIDER"),
  serviceAccountEmail: optionalString("GOOGLE_SERVICE_ACCOUNT_EMAIL"),
  tokenFile: optionalString("GOOGLE_WORKLOAD_IDENTITY_TOKEN_FILE")
})

const serviceAccountEnv = Config.all({
  inlineKey: optionalRedacted("GOOGLE_SERVICE_ACCOUNT_KEY"),
  keyFile: optionalString("GOOGLE_SERVICE_ACCOUNT_KEY_FILE"),
  keyFileFallback: optionalString("GOOGLE_APPLICATION_CREDENTIALS")
})

const impersonateEnv = optionalString("GOOGLE_IMPERSONATE_USER")

/**
 * The canonical form of a provider name, as `gcloud iam workload-identity-pools providers describe`
 * prints it.
 *
 * @category workload identity
 */
export const PROVIDER_FORMAT =
  "projects/<project-number>/locations/global/workloadIdentityPools/<pool-id>/providers/<provider-id>"

const CanonicalProviderName = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(
      /^projects\/\d+\/locations\/global\/workloadIdentityPools\/[a-z0-9-]+\/providers\/[a-z0-9-]+$/,
      { title: "workload identity provider", description: PROVIDER_FORMAT }
    )
  )
)

/**
 * A provider resource name. The `//iam.googleapis.com/` and `https://iam.googleapis.com/` prefixes
 * used in STS and OIDC audiences are accepted and stripped so any form copied from Google's console
 * or docs works; the decoded value is always canonical.
 *
 * @category workload identity
 */
export const ProviderName: Schema.decodeTo<typeof CanonicalProviderName, Schema.String> = Schema.String.pipe(
  Schema.decodeTo(CanonicalProviderName, {
    decode: Getter.transform((s: string) => s.replace(/^(https:)?\/\/iam\.googleapis\.com\//, "")),
    encode: Getter.passthrough()
  })
)
const decodeProviderName = Schema.decodeUnknownEffect(ProviderName)

/**
 * A service account email: any principal under `gserviceaccount.com`, which is the only kind of
 * identity that can be impersonated through workload identity federation.
 *
 * @category workload identity
 */
export const ServiceAccountEmail: Schema.String = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/^[^@\s]+@[^@\s]+\.gserviceaccount\.com$/, {
      title: "service account email",
      description: "<name>@<project>.iam.gserviceaccount.com"
    })
  )
)
const decodeServiceAccountEmail = Schema.decodeUnknownEffect(ServiceAccountEmail)

const configError = (error: { readonly message: string }) =>
  new CredentialError({ message: `Invalid Google credential configuration: ${error.message}`, hint: SETUP_HINT })

const readKeyFile = (path: string): Effect.Effect<Redacted.Redacted, CredentialError, FileSystem.FileSystem> =>
  FileSystem.FileSystem.use((fs) => fs.readFileString(path)).pipe(
    Effect.mapError((error) =>
      new CredentialError({ message: `Cannot read service account key file ${path}: ${error.message}` })
    ),
    Effect.map(Redacted.make)
  )

/**
 * Options for resolving a credential.
 *
 * @category models
 */
export interface ResolveOptions {
  /** Email of the current Amp user; used when `GOOGLE_IMPERSONATE_USER=amp-user`. */
  readonly ampUserEmail: Option.Option<string>
}

/**
 * The error raised when no credential kind is configured at all. Lists the options in the order
 * the setup guide recommends them.
 *
 * @category errors
 */
export const noCredentials = (): CredentialError =>
  new CredentialError({
    message: [
      "No Google credentials configured.",
      "Set one of:",
      "  - GOOGLE_WORKLOAD_IDENTITY_PROVIDER + GOOGLE_SERVICE_ACCOUNT_EMAIL (keyless; Amp workspace variables), or",
      "  - GOOGLE_OAUTH_CLIENT_ID + GOOGLE_OAUTH_CLIENT_SECRET + GOOGLE_OAUTH_REFRESH_TOKEN (acts as you; personal secrets), or",
      "  - GOOGLE_SERVICE_ACCOUNT_KEY (service account JSON; Amp workspace secret)."
    ].join("\n"),
    hint: SETUP_HINT
  })

/** `GOOGLE_IMPERSONATE_USER`: an email, or `amp-user` for the signed-in Amp user. */
const resolveSubject = (
  impersonate: Option.Option<string>,
  ampUserEmail: Option.Option<string>
): Effect.Effect<Option.Option<string>, CredentialError> =>
  Option.match(impersonate, {
    onNone: () => Effect.succeedNone,
    onSome: (value) =>
      value.toLowerCase() !== "amp-user"
        ? Effect.succeedSome(value)
        : Option.match(ampUserEmail, {
          onNone: () =>
            Effect.fail(
              new CredentialError({
                message: "GOOGLE_IMPERSONATE_USER=amp-user but the Amp user email is unavailable (not signed in?)."
              })
            ),
          onSome: (email) => Effect.succeedSome(email)
        })
  })

/**
 * Resolves the credential from the active `ConfigProvider` (the process environment by default).
 * Key files are read through the `FileSystem` service. Fails with `CredentialError` when nothing is
 * configured or the configuration is inconsistent.
 *
 * A partially configured kind is an error, never a fall-through to the next kind: a missing
 * variable is a mistake the user must see, not a reason to silently act as a different identity.
 *
 * @category constructors
 */
export const resolve = (
  options: ResolveOptions
): Effect.Effect<Credential, CredentialError, FileSystem.FileSystem> =>
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
      return Credential.OAuthRefresh({
        clientId: oauth.clientId.value,
        clientSecret: oauth.clientSecret.value,
        refreshToken: oauth.refreshToken.value
      })
    }

    const impersonate = yield* Effect.mapError(impersonateEnv, configError)

    const wif = yield* Effect.mapError(workloadIdentityEnv, configError)
    if (Option.isSome(wif.provider) || Option.isSome(wif.serviceAccountEmail)) {
      if (Option.isNone(wif.provider) || Option.isNone(wif.serviceAccountEmail)) {
        const [set, missing] = Option.isSome(wif.provider)
          ? ["GOOGLE_WORKLOAD_IDENTITY_PROVIDER", "GOOGLE_SERVICE_ACCOUNT_EMAIL"]
          : ["GOOGLE_SERVICE_ACCOUNT_EMAIL", "GOOGLE_WORKLOAD_IDENTITY_PROVIDER"]
        return yield* new CredentialError({
          message: `${set} is set but ${missing} is missing; workload identity needs both.`,
          hint: SETUP_HINT
        })
      }
      const rawProvider = wif.provider.value
      const rawEmail = wif.serviceAccountEmail.value
      const provider = yield* decodeProviderName(rawProvider).pipe(
        Effect.mapError(() =>
          new CredentialError({
            message: `GOOGLE_WORKLOAD_IDENTITY_PROVIDER must look like ${PROVIDER_FORMAT}, got "${rawProvider}".`,
            hint:
              "Copy the `name` field from: gcloud iam workload-identity-pools providers describe <provider> --location global --workload-identity-pool <pool>"
          })
        )
      )
      const serviceAccountEmail = yield* decodeServiceAccountEmail(rawEmail).pipe(
        Effect.mapError(() =>
          new CredentialError({
            message:
              `GOOGLE_SERVICE_ACCOUNT_EMAIL must be a service account (…@<project>.iam.gserviceaccount.com), got "${rawEmail}".`,
            hint:
              "Workload identity impersonates a service account; to act as a person set GOOGLE_IMPERSONATE_USER as well."
          })
        )
      )
      return Credential.WorkloadIdentity({
        provider,
        serviceAccountEmail,
        subject: yield* resolveSubject(impersonate, options.ampUserEmail),
        subjectToken: Option.match(wif.tokenFile, {
          onNone: () => SubjectTokenSource.AmpOrb(),
          onSome: (path) => SubjectTokenSource.File({ path })
        })
      })
    }

    const sa = yield* Effect.mapError(serviceAccountEnv, configError)
    const keyPath = Option.orElse(sa.keyFile, () => sa.keyFileFallback)
    const json = Option.isSome(sa.inlineKey)
      ? sa.inlineKey.value
      : Option.isSome(keyPath)
      ? yield* readKeyFile(keyPath.value)
      : yield* noCredentials()

    const key = yield* decodeKey(Redacted.value(json)).pipe(
      Effect.mapError(() =>
        new CredentialError({
          message: "Service account key is not valid JSON with \"client_email\" and \"private_key\".",
          hint:
            "Store the downloaded key file verbatim: amp secrets set --workspace GOOGLE_SERVICE_ACCOUNT_KEY --secret --data-file key.json"
        })
      )
    )

    return Credential.ServiceAccount({
      clientEmail: key.client_email,
      privateKey: Redacted.make(key.private_key),
      tokenUri: key.token_uri ?? "https://oauth2.googleapis.com/token",
      subject: yield* resolveSubject(impersonate, options.ampUserEmail)
    })
  })
