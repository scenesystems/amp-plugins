/**
 * An in-memory `HttpClient` that records every request and answers with a scripted `Response`.
 *
 * Tests assert on the recorded requests exactly (method, full URL with query, headers, decoded
 * body) so a change in how a plugin talks to an API is a test failure, not a silent drift.
 */
import * as Assert from "@effect/vitest/utils"
import * as Arr from "effect/Array"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as MutableRef from "effect/MutableRef"
import * as Option from "effect/Option"
import * as Record from "effect/Record"
import * as Schema from "effect/Schema"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientError from "effect/unstable/http/HttpClientError"
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"

/**
 * A request as the HTTP client saw it. `url` has the query string applied; `request.url` does not.
 *
 * @category models
 */
export interface Recorded {
  readonly request: HttpClientRequest.HttpClientRequest
  readonly url: URL
}

/**
 * Scripted response for the `index`-th request (0-based).
 *
 * @category models
 */
export type Reply = (recorded: Recorded, index: number) => Response

/**
 * A stub client: `requests` fills up as the program under test runs; `layer` provides `HttpClient`.
 *
 * @category models
 */
export interface Stub {
  readonly requests: ReadonlyArray<Recorded>
  readonly layer: Layer.Layer<HttpClient.HttpClient>
}

/** A stub around `send`, which sees each request after it has been recorded. */
const recording = (
  send: (
    recorded: Recorded,
    index: number
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>
): Stub => {
  const requests = MutableRef.make<ReadonlyArray<Recorded>>([])
  const client = HttpClient.make((request, url) =>
    Effect.suspend(() => {
      const recorded: Recorded = { request, url }
      const index = MutableRef.get(requests).length
      MutableRef.update(requests, Arr.append(recorded))
      return send(recorded, index)
    })
  )
  return {
    get requests() {
      return MutableRef.get(requests)
    },
    layer: Layer.succeed(HttpClient.HttpClient)(client)
  }
}

/**
 * A fake `HttpClient` that records every request and answers with `reply`.
 *
 * @category constructors
 */
export const stub = (reply: Reply): Stub =>
  recording((recorded, index) =>
    Effect.sync(() => HttpClientResponse.fromWeb(recorded.request, reply(recorded, index)))
  )

/**
 * A request the test did not script. Raised as a defect, so the test fails naming the call.
 *
 * @category errors
 */
export class UnexpectedRequest extends Schema.TaggedError<UnexpectedRequest>()("UnexpectedRequest", {
  index: Schema.Finite,
  endpoint: Schema.String
}) {
  override get message(): string {
    return `Unexpected request #${this.index}: ${this.endpoint}`
  }
}

/**
 * A fake `HttpClient` that answers the `i`-th request with `replies[i]`, in order, and dies with
 * `UnexpectedRequest` for any request past the end of the script. `script()` with no replies is a
 * client that must not be called at all.
 *
 * @category constructors
 */
export const script = (...replies: ReadonlyArray<(recorded: Recorded) => Response>): Stub =>
  recording((recorded, index) =>
    Option.match(Arr.get(replies, index), {
      onNone: () => Effect.die(new UnexpectedRequest({ index, endpoint: endpoint(recorded) })),
      onSome: (reply) => Effect.sync(() => HttpClientResponse.fromWeb(recorded.request, reply(recorded)))
    })
  )

/**
 * A fake `HttpClient` whose transport fails (DNS, refused connection, ...) with `description`.
 * Requests are still recorded.
 *
 * @category constructors
 */
export const failingTransport = (description: string): Stub =>
  recording(({ request }) =>
    Effect.fail(
      new HttpClientError.HttpClientError({
        reason: new HttpClientError.TransportError({ request, description })
      })
    )
  )

/**
 * The `index`-th recorded request. Fails the test when fewer requests were made, naming what was.
 *
 * @category readers
 */
export const request = (stub: Stub, index: number): Recorded => {
  const found = Arr.get(stub.requests, index)
  Assert.assertTrue(
    Option.isSome(found),
    `Expected at least ${index + 1} request(s), but ${stub.requests.length} were made:\n${
      stub.requests.map(endpoint).join("\n")
    }`
  )
  return found.value
}

const Json = Schema.fromJsonString(Schema.Unknown)
const encodeJson = Schema.encodeSync(Json)
const decodeJson = Schema.decodeSync(Json)

/**
 * @category responses
 */
export const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(encodeJson(body), { status, headers: { "content-type": "application/json" } })

/**
 * @category responses
 */
export const textResponse = (body: string, status = 200, contentType = "text/plain"): Response =>
  new Response(body, { status, headers: { "content-type": contentType } })

/**
 * @category responses
 */
export const emptyResponse = (status = 204): Response => new Response(null, { status })

const bodyText = ({ request }: Recorded): string => {
  const body = request.body
  Assert.assertTrue(
    body._tag === "Uint8Array",
    `Expected a Uint8Array request body but the request carried ${body._tag}`
  )
  return new TextDecoder().decode(body.body)
}

/**
 * Reads a form-encoded request body back into a record.
 *
 * @category readers
 */
export const formBody = (recorded: Recorded): Record<string, string> =>
  Record.fromEntries(new URLSearchParams(bodyText(recorded)))

/**
 * Parses a JSON request body.
 *
 * @category readers
 */
export const jsonBody = (recorded: Recorded): unknown => decodeJson(bodyText(recorded))

/**
 * The request's query parameters as a plain record (repeated keys keep the last value).
 *
 * @category readers
 */
export const query = ({ url }: Recorded): Record<string, string> => Record.fromEntries(url.searchParams)

/**
 * `METHOD https://host/path` without the query string, for asserting call sequences compactly.
 *
 * @category readers
 */
export const endpoint = ({ request, url }: Recorded): string => `${request.method} ${url.origin}${url.pathname}`
