/**
 * The external OIDC token ("subject token") that workload identity federation exchanges at Google
 * STS. Two sources:
 *
 *   AmpOrb  `amp orb id-token --audience <audience>`: a short-lived RS256 JWT issued by
 *           ampcode.com for the current orb, carrying the workspace, project, user, and thread
 *           ids. Only exists inside an orb.
 *   File    One token in a file, the shape of Google's `credential_source.file`; how CI systems
 *           and other runtimes hand over their own OIDC token.
 *
 * Both sources are read on every call: the token is minted per exchange and never cached here,
 * because the cached artifact is the Google access token that `GoogleAuth` holds.
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"
import { CredentialError, type SubjectTokenSource } from "./Credential.ts"

/**
 * Service shape.
 *
 * @category models
 */
export interface Shape {
  /** The OIDC token for `audience` from `source`. Fails with a `CredentialError` that names the source. */
  readonly get: (source: SubjectTokenSource, audience: string) => Effect.Effect<Redacted.Redacted, CredentialError>
}

/**
 * @category services
 */
export class SubjectToken
  extends Context.Service<SubjectToken, Shape>()("@scenesystems/google-workspace/SubjectToken")
{}

/**
 * Services `make` and `layer` need: a process spawner for `amp orb id-token` and a file system for
 * `GOOGLE_WORKLOAD_IDENTITY_TOKEN_FILE`.
 *
 * @category models
 */
export type Requirements = ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem

/**
 * What to do when the orb token is unavailable, appended to every AmpOrb failure.
 *
 * @category constants
 */
export const ORB_ONLY_HINT =
  "Workload identity works only inside Amp orbs, where `amp orb id-token` exists. On a laptop use OAuth (GOOGLE_OAUTH_*) or a service account key, or point GOOGLE_WORKLOAD_IDENTITY_TOKEN_FILE at an OIDC token your runtime provides."

/**
 * A compact JWS: three non-empty base64url segments. Anything else (a warning line, an empty
 * stdout, a JSON error) is rejected before it reaches Google, so the error names the real source.
 *
 * @category schemas
 */
export const CompactJwt: Schema.String = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, {
      title: "compact JWT",
      description: "header.payload.signature in base64url"
    })
  )
)
const decodeJwt = Schema.decodeUnknownEffect(CompactJwt)

const notAJwt = (from: string) => () =>
  new CredentialError({ message: `${from} did not produce a JWT (expected header.payload.signature).` })

const collect = (stream: Stream.Stream<Uint8Array, unknown>): Effect.Effect<string> =>
  stream.pipe(Stream.decodeText(), Stream.mkString, Effect.orElseSucceed(() => ""))

/**
 * Builds the service.
 *
 * @category constructors
 */
export const make: Effect.Effect<Shape, never, Requirements> = Effect.gen(function*() {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const fs = yield* FileSystem.FileSystem

  const fromAmpOrb = (audience: string): Effect.Effect<Redacted.Redacted, CredentialError> =>
    Effect.gen(function*() {
      const command = ChildProcess.make("amp", ["orb", "id-token", "--audience", audience])
      const handle = yield* spawner.spawn(command).pipe(
        Effect.mapError((error) =>
          new CredentialError({ message: `Could not run \`amp orb id-token\`: ${error.message}`, hint: ORB_ONLY_HINT })
        )
      )
      const [stdout, stderr] = yield* Effect.all([collect(handle.stdout), collect(handle.stderr)], {
        concurrency: "unbounded"
      })
      const exitCode = yield* handle.exitCode.pipe(
        Effect.mapError((error) =>
          new CredentialError({ message: `\`amp orb id-token\` did not exit cleanly: ${error.message}` })
        )
      )
      if (exitCode !== 0) {
        return yield* new CredentialError({
          message: `\`amp orb id-token\` exited with code ${exitCode}: ${
            stderr.trim() === "" ? "no error output" : stderr.trim()
          }`,
          hint: ORB_ONLY_HINT
        })
      }
      const token = yield* decodeJwt(stdout.trim()).pipe(Effect.mapError(notAJwt("`amp orb id-token`")))
      return Redacted.make(token)
    }).pipe(Effect.scoped)

  const fromFile = (path: string): Effect.Effect<Redacted.Redacted, CredentialError> =>
    fs.readFileString(path).pipe(
      Effect.mapError((error) =>
        new CredentialError({ message: `Cannot read workload identity token file ${path}: ${error.message}` })
      ),
      Effect.flatMap((text) => decodeJwt(text.trim()).pipe(Effect.mapError(notAJwt(`Token file ${path}`)))),
      Effect.map(Redacted.make)
    )

  return SubjectToken.of({
    get: (source, audience) => source._tag === "AmpOrb" ? fromAmpOrb(audience) : fromFile(source.path)
  })
})

/**
 * @category layers
 */
export const layer: Layer.Layer<SubjectToken, never, Requirements> = Layer.effect(SubjectToken)(make)
