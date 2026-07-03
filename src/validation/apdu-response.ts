/**
 * APDU response validation.
 *
 * Trust boundary #2: Browser → Device.
 * Validates response length, status words, and parses structured responses.
 */

import type { ApduResponse } from '../core/transport/types.js';
import { StatusWord } from '../core/transport/types.js';
import { HWError, HWErrorCode } from '../core/errors.js';
import type { Signature } from '../core/connector/types.js';
import {
  PUBLIC_KEY_RESPONSE_LENGTH,
  VIEWING_KEY_RESPONSE_LENGTH,
} from '../core/transport/apdu.js';

/**
 * Validate a raw APDU response — check status word and map errors.
 * Throws HWError for non-success status words.
 */
export function validateApduResponse(response: ApduResponse): void {
  if (response.statusWord === StatusWord.SUCCESS) {
    return;
  }

  if (response.statusWord === StatusWord.USER_REJECTED) {
    throw new HWError(
      HWErrorCode.APDU_REJECTED,
      `Device rejected operation (SW: 0x${response.statusWord.toString(16)})`,
    );
  }

  if (response.statusWord === StatusWord.LOCKED_DEVICE) {
    throw new HWError(
      HWErrorCode.APDU_STATUS_ERROR,
      'Device is locked. Unlock and retry.',
    );
  }

  if (response.statusWord === StatusWord.APP_NOT_OPEN) {
    throw new HWError(
      HWErrorCode.APDU_STATUS_ERROR,
      'Required app is not open on the device.',
    );
  }

  throw new HWError(
    HWErrorCode.APDU_STATUS_ERROR,
    `APDU error (SW: 0x${response.statusWord.toString(16)})`,
  );
}

/**
 * Parse a SIGN_HASH response into a Signature.
 *
 * Response layout (with prefix + echoedHash):
 *   prefix(1B) + R8.x(32B) + R8.y(32B) + S(32B) + echoedHash(32B) = 129 bytes
 *
 * Without prefix: R8.x(32B) + R8.y(32B) + S(32B) [+ echoedHash(32B)] = 96 or 128.
 * With prefix: prefix(1B) + R8.x(32B) + R8.y(32B) + S(32B) [+ echoedHash(32B)] = 97 or 129.
 *
 * @param data - Raw response bytes from device
 * @param hasPrefix - Whether the response includes a 1-byte prefix (default: true)
 */
export function parseSignResponse(data: Uint8Array, hasPrefix = true): Signature {
  const sigOnly = hasPrefix ? 97 : 96;
  const sigWithHash = hasPrefix ? 129 : 128;

  if (data.length !== sigOnly && data.length !== sigWithHash) {
    throw new HWError(
      HWErrorCode.SIGN_INVALID_RESPONSE,
      `Expected ${String(sigOnly)} or ${String(sigWithHash)} bytes for sign response, got ${String(data.length)}`,
    );
  }

  const offset = hasPrefix ? 1 : 0;
  const r8x = bytesToBigInt(data.subarray(offset, offset + 32));
  const r8y = bytesToBigInt(data.subarray(offset + 32, offset + 64));
  const s = bytesToBigInt(data.subarray(offset + 64, offset + 96));

  return { R8: [r8x, r8y] as const, S: s };
}

/**
 * Extract the echoed hash from a sign response, if present.
 *
 * The echoed hash occupies the trailing 32 bytes after the signature.
 * Returns null if the response does not include an echoed hash.
 *
 * @param data - Raw response bytes from device
 * @param hasPrefix - Whether the response includes a 1-byte prefix
 */
export function extractEchoedHash(data: Uint8Array, hasPrefix = true): Uint8Array | null {
  const sigOnly = hasPrefix ? 97 : 96;
  if (data.length <= sigOnly) return null;
  return data.slice(sigOnly, sigOnly + 32);
}

/**
 * Parse a GET_PUBLIC_KEY response.
 * Expected: x (32B) + y (32B) = 64 bytes.
 */
export function parsePublicKeyResponse(
  data: Uint8Array,
): { readonly x: bigint; readonly y: bigint } {
  if (data.length !== PUBLIC_KEY_RESPONSE_LENGTH) {
    throw new HWError(
      HWErrorCode.APDU_INVALID_RESPONSE,
      `Expected ${String(PUBLIC_KEY_RESPONSE_LENGTH)} bytes for public key, got ${String(data.length)}`,
    );
  }

  return {
    x: bytesToBigInt(data.subarray(0, 32)),
    y: bytesToBigInt(data.subarray(32, 64)),
  };
}

/**
 * Parse a GET_VIEWING_KEY response.
 * Expected: viewing private key (32B).
 */
export function parseViewingKeyResponse(data: Uint8Array): Uint8Array {
  if (data.length !== VIEWING_KEY_RESPONSE_LENGTH) {
    throw new HWError(
      HWErrorCode.APDU_INVALID_RESPONSE,
      `Expected ${String(VIEWING_KEY_RESPONSE_LENGTH)} bytes for viewing key, got ${String(data.length)}`,
    );
  }
  // Return a copy to prevent mutation of the transport buffer
  return data.slice();
}

/**
 * Convert a big-endian Uint8Array to bigint.
 */
function bytesToBigInt(bytes: Uint8Array): bigint {
  let result = 0n;
  for (const byte of bytes) {
    result = (result << 8n) | BigInt(byte);
  }
  return result;
}
