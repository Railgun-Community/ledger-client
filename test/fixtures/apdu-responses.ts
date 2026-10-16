/**
 * Mock APDU responses for testing.
 *
 * These fixtures simulate real device responses without requiring hardware.
 * All values are synthetic — do not use in production.
 */

import { StatusWord } from '../../src/core/transport/types.js';
import type { ApduCommand, ApduResponse } from '../../src/core/transport/types.js';

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

/**
 * Synthetic sign response (97 bytes: prefix + R8.x + R8.y + S).
 * R8 = (0, 1) — the twisted-Edwards neutral point, on the BabyJubjub curve — and
 * S = 7, inside the prime-order subgroup, so it passes signature validation.
 * For parser tests only: it has no echoed hash, so `RailgunSigner.sign()` rejects
 * it — use {@link signHashResponder} for a sign flow.
 */
export const MOCK_SIGN_RESPONSE = new Uint8Array(97);
MOCK_SIGN_RESPONSE[0] = 0x00;   // prefix byte
// R8.x = 0 (bytes 1..32 remain zero); R8.y = 1 (big-endian LSB at byte 64); S = 7.
MOCK_SIGN_RESPONSE[64] = 0x01;  // R8.y
MOCK_SIGN_RESPONSE[96] = 0x07;  // S

/**
 * SIGN_HASH (INS 0x12) reply as the RAILGUN app sends it (129 bytes):
 * sigLen(1) = 0x60 ‖ R8.x(32) ‖ R8.y(32) ‖ S(32) ‖ msg(32), where `msg` echoes the
 * 32-byte hash of the command (`account(4) ‖ msg(32)`). Returned as a responder so
 * the echo always matches what the host sent.
 */
export function signHashResponder(r8x = 0n, r8y = 1n, s = 7n): (command: ApduCommand) => ApduResponse {
  return (command) => {
    const data = new Uint8Array(129);
    data[0] = 0x60;
    for (const [offset, value] of [[1, r8x], [33, r8y], [65, s]] as const) {
      let v = value;
      for (let i = 31; i >= 0; i--) {
        data[offset + i] = Number(v & 0xffn);
        v >>= 8n;
      }
    }
    data.set(command.data.subarray(4, 36), 97);
    return successResponse(data);
  };
}

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
