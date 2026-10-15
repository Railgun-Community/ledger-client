/**
 * Canonical device status-word → typed-error mapping, and typed classification
 * of lower-level errors thrown by @ledgerhq transport/app libraries.
 *
 * Prefer these over ad-hoc hex-string comparisons or English-substring matching
 * on error messages — the latter is fragile across @ledgerhq versions and locales.
 */

import { HWError, HWErrorCode } from '../errors.js';
import { StatusWord } from './types.js';

/** Map a NON-success device status word to a typed HWError. */
export function statusWordToHWError(statusWord: number): HWError {
  switch (statusWord) {
    case StatusWord.USER_REJECTED:
      return new HWError(
        HWErrorCode.APDU_REJECTED,
        `Device rejected operation (SW: 0x${statusWord.toString(16)})`,
      );
    case StatusWord.LOCKED_DEVICE:
      return new HWError(HWErrorCode.APDU_STATUS_ERROR, 'Device is locked. Unlock and retry.');
    case StatusWord.APP_NOT_OPEN:
      return new HWError(HWErrorCode.APDU_STATUS_ERROR, 'Required app is not open on the device.');
    case StatusWord.BAD_STATE:
      return new HWError(
        HWErrorCode.APDU_STATUS_ERROR,
        'RAILGUN app state error (SW 0xb007) — the instruction arrived in the wrong state, e.g. a CLEAR_SIGN sub-command out of order or without an active session.',
      );
    case StatusWord.SIGNATURE_FAIL:
      return new HWError(
        HWErrorCode.APDU_STATUS_ERROR,
        'RAILGUN app signing failed on the device (SW 0xb008).',
      );
    case StatusWord.INVALID_DATA:
      return new HWError(HWErrorCode.APDU_STATUS_ERROR, 'Device rejected the command data as malformed (SW 0x6a80).');
    case StatusWord.WRONG_P1P2:
      return new HWError(HWErrorCode.APDU_STATUS_ERROR, 'Device rejected the command parameters P1/P2 (SW 0x6a86).');
    case StatusWord.WRONG_DATA_LENGTH:
      return new HWError(HWErrorCode.APDU_STATUS_ERROR, 'Device rejected the command data length (SW 0x6a87).');
    case StatusWord.INS_NOT_SUPPORTED:
      return new HWError(
        HWErrorCode.APDU_STATUS_ERROR,
        'Instruction not supported by the open app (SW 0x6d00) — the app may be an older or debug-only build, or not the RAILGUN app.',
      );
    case StatusWord.CLA_NOT_SUPPORTED:
      return new HWError(HWErrorCode.APDU_STATUS_ERROR, 'Instruction class not supported by the open app (SW 0x6e00).');
    default:
      return new HWError(
        HWErrorCode.APDU_STATUS_ERROR,
        `APDU error (SW: 0x${statusWord.toString(16)})`,
      );
  }
}

function nonEmpty(message: string, fallback: string): string {
  return message.length > 0 ? message : fallback;
}

/**
 * Classify an unknown error thrown by a transport/app library using its TYPED
 * shape first — a numeric `statusCode` (@ledgerhq `TransportStatusError`) or an
 * error class name (`DisconnectedDevice`…) — and fall back to message-text
 * matching only when no typed signal is present. Returns `null` when it cannot
 * classify, so callers can apply their own default.
 */
export function classifyDeviceError(error: unknown): HWError | null {
  const message = error instanceof Error ? error.message : '';

  if (typeof error === 'object' && error !== null) {
    const typed = error as { statusCode?: unknown; name?: unknown };
    if (typeof typed.statusCode === 'number') {
      if (typed.statusCode === StatusWord.USER_REJECTED) {
        return new HWError(
          HWErrorCode.SIGN_REJECTED_DEVICE,
          nonEmpty(message, 'Device rejected the operation.'),
          error,
        );
      }
      if (typed.statusCode === StatusWord.LOCKED_DEVICE) {
        return new HWError(HWErrorCode.DEVICE_LOCKED, nonEmpty(message, 'Device is locked.'), error);
      }
    }
    if (typeof typed.name === 'string' && typed.name.includes('Disconnected')) {
      return new HWError(
        HWErrorCode.TRANSPORT_DISCONNECTED,
        nonEmpty(message, 'Device disconnected.'),
        error,
      );
    }
  }

  // Message-text fallback (last resort — see module note).
  const lowered = message.toLowerCase();
  if (
    lowered.includes('rejected')
    || lowered.includes('denied')
    || lowered.includes('cancelled')
    || lowered.includes('canceled')
  ) {
    return new HWError(HWErrorCode.SIGN_REJECTED_DEVICE, message, error);
  }
  if (lowered.includes('timeout')) {
    return new HWError(HWErrorCode.TRANSPORT_TIMEOUT, message, error);
  }
  if (
    lowered.includes('disconnect')
    || lowered.includes('disconnected')
    || lowered.includes('connection lost')
    || lowered.includes('closed')
  ) {
    return new HWError(HWErrorCode.TRANSPORT_DISCONNECTED, message, error);
  }
  return null;
}
