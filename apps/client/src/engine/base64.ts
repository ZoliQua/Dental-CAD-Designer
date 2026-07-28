// apps/client/src/engine/base64.ts
//
// Pure RFC 4648 base64 encoding (standard alphabet, '=' padded) for
// `RestorationExportRequest.bytesBase64` (Phase 7 Task 3). Implemented
// directly rather than via `btoa` (which requires a byte→binary-string
// detour and chunked `String.fromCharCode` calls to avoid argument-list
// limits on multi-MB exports) or `Buffer` (Node-only — the engine runs in
// the browser). Deterministic, environment-agnostic, O(n); verified
// byte-for-byte against Node's reference implementation in base64.test.ts.
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Encodes `bytes` (respecting its view offset/length) as standard padded
 * base64. */
export function bytesToBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  const fullTriples = Math.floor(bytes.length / 3);
  for (let t = 0; t < fullTriples; t++) {
    const i = t * 3;
    const chunk = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    parts.push(
      ALPHABET[(chunk >> 18) & 63]! + ALPHABET[(chunk >> 12) & 63]! + ALPHABET[(chunk >> 6) & 63]! + ALPHABET[chunk & 63]!,
    );
  }
  const remainder = bytes.length - fullTriples * 3;
  if (remainder === 1) {
    const chunk = bytes[bytes.length - 1]! << 16;
    parts.push(ALPHABET[(chunk >> 18) & 63]! + ALPHABET[(chunk >> 12) & 63]! + '==');
  } else if (remainder === 2) {
    const chunk = (bytes[bytes.length - 2]! << 16) | (bytes[bytes.length - 1]! << 8);
    parts.push(ALPHABET[(chunk >> 18) & 63]! + ALPHABET[(chunk >> 12) & 63]! + ALPHABET[(chunk >> 6) & 63]! + '=');
  }
  return parts.join('');
}
