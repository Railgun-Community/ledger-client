/**
 * Mock APDU responses for testing.
 *
 * These fixtures simulate real device responses without requiring hardware.
 * All values are synthetic — do not use in production.
 */

import { StatusWord } from '../../src/core/transport/types.js';
import type { ApduResponse } from '../../src/core/transport/types.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Create a successful APDU response with given data. */
export function successResponse(data: Uint8Array): ApduResponse {
  return { data, statusWord: StatusWord.SUCCESS };
}

/** Create an error APDU response with given status word. */
export function errorResponse(statusWord: number): ApduResponse {
  return { data: new Uint8Array(0), statusWord };
}

// ─── Synthetic key/signature data ─────────────────────────────────────────────

/** Synthetic 32-byte value (all 0x01). */
export const MOCK_32_BYTES = new Uint8Array(32).fill(0x01);

/** Synthetic public key response (64 bytes: x + y). */
export const MOCK_PUBLIC_KEY_RESPONSE = new Uint8Array(64).fill(0xaa);

/** Synthetic sign response (97 bytes: prefix + R8.x + R8.y + S). */
export const MOCK_SIGN_RESPONSE = new Uint8Array(97);
MOCK_SIGN_RESPONSE[0] = 0x00;                                    // prefix byte
MOCK_SIGN_RESPONSE.set(new Uint8Array(32).fill(0x11), 1);        // R8.x
MOCK_SIGN_RESPONSE.set(new Uint8Array(32).fill(0x22), 33);       // R8.y
MOCK_SIGN_RESPONSE.set(new Uint8Array(32).fill(0x33), 65);       // S

// ─── Common response fixtures ─────────────────────────────────────────────────

export const APDU_FIXTURES = {
  signSuccess: successResponse(MOCK_SIGN_RESPONSE),
  publicKeySuccess: successResponse(MOCK_PUBLIC_KEY_RESPONSE),
  userRejected: errorResponse(StatusWord.USER_REJECTED),
  lockedDevice: errorResponse(StatusWord.LOCKED_DEVICE),
  appNotOpen: errorResponse(StatusWord.APP_NOT_OPEN),
  internalError: errorResponse(StatusWord.INTERNAL_ERROR),
  wrongLength: errorResponse(StatusWord.WRONG_LENGTH),
  invalidData: errorResponse(StatusWord.INVALID_DATA),
} as const;

/** Truncated sign response (only 64 bytes instead of 96). */
export const TRUNCATED_SIGN_RESPONSE = successResponse(
  new Uint8Array(64).fill(0xff),
);

/** Empty data response with success status. */
export const EMPTY_SUCCESS_RESPONSE = successResponse(new Uint8Array(0));
