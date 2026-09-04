/**
 * Shared fixtures: a throwaway RSA key pair rendered like a downloaded service-account JSON,
 * and an in-memory `HttpClient` that records requests and replays scripted responses.
 */
import type { PluginAPI } from "@ampcode/plugin"
import { Amp } from "@scenesystems/amp-plugin-core"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as Layer from "effect/Layer"
import * as HttpClient from "effect/unstable/http/HttpClient"
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"

export interface TestKey {
  readonly publicKey: CryptoKey
  readonly json: string
  readonly clientEmail: string
}

const toPem = (der: ArrayBuffer): string => {
  const base64 = Encoding.encodeBase64(new Uint8Array(der))
  const lines = base64.match(/.{1,64}/g) ?? []
  return `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----\n`
}

/** Generates a 2048-bit RSA key and the matching service-account key JSON. */
export const generateTestKey = async (): Promise<TestKey> => {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"]
  )
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", pair.privateKey)
  const clientEmail = "amp-test@example-project.iam.gserviceaccount.com"
  const json = JSON.stringify({
    type: "service_account",
    project_id: "example-project",
    client_email: clientEmail,
    private_key: toPem(pkcs8),
    token_uri: "https://oauth2.googleapis.com/token"
  })
  return { publicKey: pair.publicKey, json, clientEmail }
}

/** Reads a form-encoded request body back into a record. */
export const formBody = ({ request }: Recorded): Record<string, string> => {
  const body = request.body
  if (body._tag !== "Uint8Array") throw new Error(`expected a Uint8Array body, got ${body._tag}`)
  return Object.fromEntries(new URLSearchParams(new TextDecoder().decode(body.body)))
}

/** A request as the HTTP client saw it: `url` has the query string applied, `request.url` does not. */
export interface Recorded {
  readonly request: HttpClientRequest.HttpClientRequest
  readonly url: URL
}

export type Reply = (recorded: Recorded, index: number) => Response

/** A fake `HttpClient` that records every request and answers with `reply`. */
export const stubClient = (reply: Reply) => {
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

export const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

export const textResponse = (body: string, status = 200): Response =>
  new Response(body, { status, headers: { "content-type": "text/plain" } })

/** `Amp` layer with just enough of the plugin API for the auth code path. */
export const ampLayer = (email: string | null = "ari@example.com") =>
  Amp.layer({ system: { user: email === null ? null : { email } } } as unknown as PluginAPI)
