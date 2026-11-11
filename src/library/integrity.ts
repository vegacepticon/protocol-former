// src/library/integrity.ts
// Pure SHA-256 integrity helpers via Web Crypto (globalThis.crypto.subtle).
// Zero Obsidian imports (NFR-01). Framed as INTEGRITY verification (detects
// byte corruption/tampering relative to a manifest hash), NOT publisher
// authenticity — ed25519 signature verification is deferred (D11). The UI
// must never mark unsigned releases as trusted.

/** Hex-encode an ArrayBuffer to a lowercase SHA-256 hex string. */
function toHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i]!.toString(16).padStart(2, '0');
  }
  return out;
}

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (s === undefined) {
    throw new Error('[Protocol Former] Web Crypto subtle.digest unavailable — cannot compute SHA-256');
  }
  return s;
}

/**
 * Compute the SHA-256 hex of a string's UTF-8 bytes.
 * Throws a plain Error if Web Crypto is unavailable (environment misconfig).
 */
export async function sha256String(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content);
  const digest = await subtle().digest('SHA-256', bytes);
  return toHex(digest as ArrayBuffer);
}

/**
 * Compute the SHA-256 hex of arbitrary bytes (ArrayBuffer or Uint8Array).
 * Copy-constructs a fresh Uint8Array<ArrayBuffer> so the value satisfies the
 * strict lib.dom BufferSource (ArrayBufferView<ArrayBuffer>) typing.
 */
export async function sha256Bytes(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const view =
    bytes instanceof Uint8Array
      ? new Uint8Array(bytes)
      : new Uint8Array(bytes);
  const digest = await subtle().digest('SHA-256', view);
  return toHex(digest as ArrayBuffer);
}

/**
 * Verify a content string's integrity against an expected SHA-256 hex.
 * Returns true on match, false on mismatch. NEVER throws on mismatch —
 * integrity failure is a recoverable install error, not an exception.
 * Throws only if Web Crypto is unavailable (environment misconfiguration).
 */
export async function verifyIntegrity(content: string, expectedSha256: string): Promise<boolean> {
  const actual = await sha256String(content);
  return actual.toLowerCase() === expectedSha256.toLowerCase();
}
