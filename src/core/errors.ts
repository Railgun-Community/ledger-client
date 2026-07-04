/**
 * Core error types for @railgun-community/ledger-client.
 *
 * All errors in the system are typed. No raw strings or generic Error objects
 * should be thrown from core modules.
 */

export const HWErrorCode = {
  // Transport errors
  TRANSPORT_NOT_AVAILABLE: 'TRANSPORT_NOT_AVAILABLE',
  TRANSPORT_CONNECTION_FAILED: 'TRANSPORT_CONNECTION_FAILED',
  TRANSPORT_DISCONNECTED: 'TRANSPORT_DISCONNECTED',
  TRANSPORT_TIMEOUT: 'TRANSPORT_TIMEOUT',

  // Protocol errors
  APDU_INVALID_RESPONSE: 'APDU_INVALID_RESPONSE',
  APDU_STATUS_ERROR: 'APDU_STATUS_ERROR',
  APDU_REJECTED: 'APDU_REJECTED',

  // Device errors
  DEVICE_NOT_FOUND: 'DEVICE_NOT_FOUND',
  DEVICE_LOCKED: 'DEVICE_LOCKED',
  APP_NOT_INSTALLED: 'APP_NOT_INSTALLED',
  APP_VERSION_MISMATCH: 'APP_VERSION_MISMATCH',
  APP_OPEN_FAILED: 'APP_OPEN_FAILED',

  // Signing errors
  SIGN_REJECTED_DEVICE: 'SIGN_REJECTED_DEVICE',
  SIGN_REJECTED_USER: 'SIGN_REJECTED_USER',
  SIGN_INVALID_RESPONSE: 'SIGN_INVALID_RESPONSE',
  SIGN_BUSY: 'SIGN_BUSY',
  SIGN_BLIND_NOT_ALLOWED: 'SIGN_BLIND_NOT_ALLOWED',

  // Validation errors
  VALIDATION_PUBLIC_INPUTS: 'VALIDATION_PUBLIC_INPUTS',
  VALIDATION_HASH: 'VALIDATION_HASH',
  VALIDATION_SIGNATURE: 'VALIDATION_SIGNATURE',
  VALIDATION_DERIVATION_INDEX: 'VALIDATION_DERIVATION_INDEX',
  VALIDATION_MANIFEST: 'VALIDATION_MANIFEST',

  // Batch errors
  BATCH_REJECTED: 'BATCH_REJECTED',
  BATCH_PARTIAL_FAILURE: 'BATCH_PARTIAL_FAILURE',
} as const;

export type HWErrorCode = (typeof HWErrorCode)[keyof typeof HWErrorCode];

export class HWError extends Error {
  readonly code: HWErrorCode;
  readonly cause?: unknown;

  constructor(code: HWErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'HWError';
    this.code = code;
    this.cause = cause;
  }
}
