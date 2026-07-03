/**
 * APDU wire-format serialization and deserialization.
 *
 * Converts between typed ApduCommand/ApduResponse and raw byte arrays.
 * These are transport-agnostic — used by any HWTransport implementation.
 */

import type { ApduCommand, ApduResponse } from './types.js';
import { HWError, HWErrorCode } from '../errors.js';

/**
 * Serialize an ApduCommand to a raw byte array for transmission.
 *
 * Wire format: [CLA][INS][P1][P2][Lc][DATA...]
 * If no data: [CLA][INS][P1][P2]
 *
 * Note: Ledger transports handle framing/chunking internally.
 * This produces the APDU body that the transport.send() expects.
 */
export function serializeApdu(command: ApduCommand): Uint8Array {
  const dataLen = command.data?.length ?? 0;

  if (dataLen > 255) {
    throw new HWError(
      HWErrorCode.APDU_INVALID_RESPONSE,
      `APDU data length exceeds 255 bytes: ${String(dataLen)}`,
    );
  }

  if (dataLen === 0) {
    return new Uint8Array([command.cla, command.ins, command.p1, command.p2]);
  }

  const buf = new Uint8Array(5 + dataLen);
  buf[0] = command.cla;
  buf[1] = command.ins;
  buf[2] = command.p1;
  buf[3] = command.p2;
  buf[4] = dataLen;
  buf.set(command.data!, 5);
  return buf;
}

/**
 * Deserialize a raw APDU response from the device.
 *
 * Response format: [DATA...][SW1][SW2]
 * Minimum length: 2 bytes (just status word, no data).
 */
export function deserializeApduResponse(raw: Uint8Array): ApduResponse {
  if (raw.length < 2) {
    throw new HWError(
      HWErrorCode.APDU_INVALID_RESPONSE,
      `APDU response too short: ${String(raw.length)} bytes (minimum 2)`,
    );
  }

  const sw1 = raw[raw.length - 2]!;
  const sw2 = raw[raw.length - 1]!;
  const statusWord = (sw1 << 8) | sw2;
  const data = raw.subarray(0, raw.length - 2);

  return { data, statusWord };
}

/**
 * Format a status word as a hex string for logging/display.
 */
export function formatStatusWord(sw: number): string {
  return `0x${sw.toString(16).padStart(4, '0').toUpperCase()}`;
}
