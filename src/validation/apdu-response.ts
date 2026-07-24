/**
 * APDU response validation.
 *
 * Trust boundary #2: Browser → Device.
 * Validates response length, status words, and parses structured responses.
 */

import type { ApduResponse } from '../core/transport/types.js';
import { StatusWord } from '../core/transport/types.js';
import { HWError, HWErrorCode } from '../core/errors.js';
import { statusWordToHWError } from '../core/transport/status-words.js';
import type { Signature } from '../core/connector/types.js';
import {
  PUBLIC_KEY_RESPONSE_LENGTH,
  VIEWING_KEY_RESPONSE_LENGTH,
  VIEWING_PUBLIC_KEY_RESPONSE_LENGTH,
  RAILGUN_ADDRESS_RESPONSE_LENGTH,
} from '../core/transport/apdu.js';

/**
 * Validate a raw APDU response — check status word and map errors.
 * Throws HWError for non-success status words.
 */
export function validateApduResponse(response: ApduResponse): void {
  if (response.statusWord === StatusWord.SUCCESS) {
    return;
  }
  throw statusWordToHWError(response.statusWord);
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
 * Parse a GET_VIEWING_PUBLIC_KEY response (INS 0x10).
 * Expected: compressed Ed25519 viewing public key (32B). Returns a copy.
 */
export function parseViewingPublicKeyResponse(data: Uint8Array): Uint8Array {
  if (data.length !== VIEWING_PUBLIC_KEY_RESPONSE_LENGTH) {
    throw new HWError(
      HWErrorCode.APDU_INVALID_RESPONSE,
      `Expected ${String(VIEWING_PUBLIC_KEY_RESPONSE_LENGTH)} bytes for viewing public key, got ${String(data.length)}`,
    );
  }
  return data.slice();
}

/**
 * Parse a GET_RAILGUN_ADDRESS response (INS 0x14).
 * Expected: exactly 127 ASCII bytes (a `0zk1…` string, not NUL-terminated).
 * The device fixes the width, so a non-127 length is a protocol error.
 */
export function parseRailgunAddressResponse(data: Uint8Array): string {
  if (data.length !== RAILGUN_ADDRESS_RESPONSE_LENGTH) {
    throw new HWError(
      HWErrorCode.APDU_INVALID_RESPONSE,
      `Expected ${String(RAILGUN_ADDRESS_RESPONSE_LENGTH)} bytes for RAILGUN address, got ${String(data.length)}`,
    );
  }
  for (const byte of data) {
    if (byte < 0x20 || byte > 0x7e) {
      throw new HWError(
        HWErrorCode.APDU_INVALID_RESPONSE,
        'RAILGUN address response contains a non-printable-ASCII byte',
      );
    }
  }
  let address = '';
  for (const byte of data) {
    address += String.fromCharCode(byte);
  }
  return address;
}

/**
 * Parse a CLEAR_SIGN single-tx FINALIZE response (INS 0x11, P1 0x40).
 *
 * Layout (129 bytes): sig_len(1)=0x60 ‖ R8.x(32) ‖ R8.y(32) ‖ S(32) ‖ msgHash(32).
 * This is byte-identical to the prefixed SIGN_HASH response, so the signature
 * and echoed message hash are parsed with the shared helpers; the only extra
 * check is that the length prefix is 0x60 (3×32).
 *
 * @returns the parsed EdDSA signature and the 32-byte message hash the device signed.
 */
export function parseClearSignFinalize(
  data: Uint8Array,
): { readonly signature: Signature; readonly msgHash: Uint8Array } {
  if (data.length !== 129) {
    throw new HWError(
      HWErrorCode.SIGN_INVALID_RESPONSE,
      `Expected 129 bytes for CLEAR_SIGN FINALIZE response, got ${String(data.length)}`,
    );
  }
  if (data[0] !== 0x60) {
    throw new HWError(
      HWErrorCode.SIGN_INVALID_RESPONSE,
      `CLEAR_SIGN FINALIZE signature-length prefix must be 0x60, got 0x${(data[0] ?? 0).toString(16)}`,
    );
  }
  const signature = parseSignResponse(data, true);
  const msgHash = extractEchoedHash(data, true);
  if (msgHash === null) {
    throw new HWError(
      HWErrorCode.SIGN_INVALID_RESPONSE,
      'CLEAR_SIGN FINALIZE response is missing the echoed message hash',
    );
  }
  return { signature, msgHash };
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
