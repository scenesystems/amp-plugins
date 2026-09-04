/**
 * A throwaway RSA key pair rendered exactly like a downloaded service-account JSON, so auth tests
 * can verify the JWTs the plugin signs with the matching public key.
 */
import * as Encoding from "effect/Encoding"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import type { webcrypto } from "node:crypto"
import type * as Credential from "../../src/Credential.ts"

export interface TestKey {
  readonly publicKey: webcrypto.CryptoKey
  /** The service-account JSON, byte-for-byte what `GOOGLE_SERVICE_ACCOUNT_KEY` would hold. */
  readonly json: string
  readonly privateKeyPem: string
  readonly clientEmail: string
  /** The credential `Credential.resolve` produces from `json` with no impersonation. */
  readonly serviceAccount: Credential.ServiceAccount
}

const toPem = (der: ArrayBuffer): string => {
  const base64 = Encoding.encodeBase64(new Uint8Array(der))
  const lines = base64.match(/.{1,64}/g) ?? []
  return `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----\n`
}

export const CLIENT_EMAIL = "amp-test@example-project.iam.gserviceaccount.com"
export const TOKEN_URI = "https://oauth2.googleapis.com/token"

/** Generates a 2048-bit RSA key and the matching service-account key JSON. */
export const generateTestKey = async (): Promise<TestKey> => {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"]
  )
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", pair.privateKey)
  const privateKeyPem = toPem(pkcs8)
  const json = JSON.stringify({
    type: "service_account",
    project_id: "example-project",
    client_email: CLIENT_EMAIL,
    private_key: privateKeyPem,
    token_uri: TOKEN_URI
  })
  return {
    publicKey: pair.publicKey,
    json,
    privateKeyPem,
    clientEmail: CLIENT_EMAIL,
    serviceAccount: {
      _tag: "ServiceAccount",
      clientEmail: CLIENT_EMAIL,
      privateKey: Redacted.make(privateKeyPem),
      tokenUri: TOKEN_URI,
      subject: Option.none()
    }
  }
}
