/**
 * An in-memory `HttpClient` that records every request and answers with a scripted `Response`.
 *
 * Tests assert on the recorded requests exactly (method, full URL with query, headers, decoded
 * body) so a change in how a plugin talks to an API is a test failure, not a silent drift.
 *
 * @since 0.2.0
 */
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientError from "effect/unstable/http/HttpClientError"
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"

/**
 * A request as the HTTP client saw it. `url` has the query string applied; `request.url` does not.
 *
 * @since 0.2.0
 * @category models
 */
export interface Recorded {
  readonly request: HttpClientRequest.HttpClientRequest
  readonly url: URL
}

/**
 * Scripted response for the `index`-th request (0-based).
 *
 * @since 0.2.0
 * @category models
 */
export type Reply = (recorded: Recorded, index: number) => Response

/**
 * A stub client: `requests` fills up as the program under test runs; `layer` provides `HttpClient`.
 *
 * @since 0.2.0
 * @category models
 */
export interface Stub {
  readonly requests: ReadonlyArray<Recorded>
  readonly layer: Layer.Layer<HttpClient.HttpClient>
}

/**
 * A fake `HttpClient` that records every request and answers with `reply`.
 *
 * @since 0.2.0
 * @category constructors
 */
export const stub = (reply: Reply): Stub => {
  const requests: Array<Recorded> = []
  const client = HttpClient.make((request, url) =>
    Effect.sync(() => {
      const recorded: Recorded = { request, url }
      requests.push(recorded)
      return HttpClientResponse.fromWeb(request, reply(recorded, requests.length - 1))
    })
  )
  return { requests, layer: Layer.succeed(HttpClient.HttpClient)(client) }
}

/**
 * A fake `HttpClient` whose transport fails (DNS, refused connection, ...) with `description`.
 * Requests are still recorded.
 *
 * @since 0.2.0
 * @category constructors
 */
export const failingTransport = (description: string): Stub => {
  const requests: Array<Recorded> = []
  const client = HttpClient.make((request, url) =>
    Effect.suspend(() => {
      requests.push({ request, url })
      return Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, description })
        })
      )
    })
  )
  return { requests, layer: Layer.succeed(HttpClient.HttpClient)(client) }
}

/**
 * @since 0.2.0
 * @category responses
 */
export const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

/**
 * @since 0.2.0
 * @category responses
 */
export const textResponse = (body: string, status = 200, contentType = "text/plain"): Response =>
  new Response(body, { status, headers: { "content-type": contentType } })

/**
 * @since 0.2.0
 * @category responses
 */
export const emptyResponse = (status = 204): Response => new Response(null, { status })

const bodyText = ({ request }: Recorded): string => {
  const body = request.body
  if (body._tag !== "Uint8Array") {
    throw new Error(`Expected a Uint8Array request body but the request carried ${body._tag}`)
  }
  return new TextDecoder().decode(body.body)
}

/**
 * Reads a form-encoded request body back into a record.
 *
 * @since 0.2.0
 * @category readers
 */
export const formBody = (recorded: Recorded): Record<string, string> =>
  Object.fromEntries(new URLSearchParams(bodyText(recorded)))

/**
 * Parses a JSON request body.
 *
 * @since 0.2.0
 * @category readers
 */
export const jsonBody = (recorded: Recorded): unknown => JSON.parse(bodyText(recorded))

/**
 * The request's query parameters as a plain record (repeated keys keep the last value).
 *
 * @since 0.2.0
 * @category readers
 */
export const query = ({ url }: Recorded): Record<string, string> => Object.fromEntries(url.searchParams)

/**
 * `METHOD https://host/path` without the query string, for asserting call sequences compactly.
 *
 * @since 0.2.0
 * @category readers
 */
export const endpoint = ({ request, url }: Recorded): string => `${request.method} ${url.origin}${url.pathname}`
