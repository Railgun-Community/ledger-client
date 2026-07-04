/**
 * Tests for the canonical status-word mapping and typed error classification.
 */

import { describe, it, expect } from 'vitest';
import {
  statusWordToHWError,
  classifyDeviceError,
} from '../../src/core/transport/status-words.js';
import { HWErrorCode } from '../../src/core/errors.js';
import { StatusWord } from '../../src/core/transport/types.js';

describe('statusWordToHWError', () => {
  it('maps USER_REJECTED to APDU_REJECTED', () => {
    expect(statusWordToHWError(StatusWord.USER_REJECTED).code).toBe(HWErrorCode.APDU_REJECTED);
  });

  it('maps LOCKED_DEVICE and APP_NOT_OPEN to APDU_STATUS_ERROR', () => {
    expect(statusWordToHWError(StatusWord.LOCKED_DEVICE).code).toBe(HWErrorCode.APDU_STATUS_ERROR);
    expect(statusWordToHWError(StatusWord.APP_NOT_OPEN).code).toBe(HWErrorCode.APDU_STATUS_ERROR);
  });

  it('maps an unknown status word to APDU_STATUS_ERROR with the SW in the message', () => {
    const err = statusWordToHWError(0x1234);
    expect(err.code).toBe(HWErrorCode.APDU_STATUS_ERROR);
    expect(err.message).toContain('0x1234');
  });
});

describe('classifyDeviceError', () => {
  it('classifies by statusCode even when the message has no keyword', () => {
    // @ledgerhq TransportStatusError shape: numeric statusCode + a message the old
    // substring matcher would NOT catch ('rejected' does not appear).
    const err = Object.assign(
      new Error('Ledger device: Condition of use not satisfied (0x6985)'),
      { statusCode: StatusWord.USER_REJECTED },
    );
    expect(classifyDeviceError(err)?.code).toBe(HWErrorCode.SIGN_REJECTED_DEVICE);
  });

  it('classifies a disconnect by error class name', () => {
    const err = Object.assign(new Error('nope'), { name: 'DisconnectedDevice' });
    expect(classifyDeviceError(err)?.code).toBe(HWErrorCode.TRANSPORT_DISCONNECTED);
  });

  it('falls back to message text when there is no typed signal', () => {
    expect(classifyDeviceError(new Error('operation timeout'))?.code).toBe(
      HWErrorCode.TRANSPORT_TIMEOUT,
    );
    expect(classifyDeviceError(new Error('user rejected on device'))?.code).toBe(
      HWErrorCode.SIGN_REJECTED_DEVICE,
    );
    expect(classifyDeviceError(new Error('connection lost'))?.code).toBe(
      HWErrorCode.TRANSPORT_DISCONNECTED,
    );
  });

  it('returns null when it cannot classify', () => {
    expect(classifyDeviceError(new Error('some other failure'))).toBeNull();
    expect(classifyDeviceError('not an error object')).toBeNull();
    expect(classifyDeviceError(null)).toBeNull();
  });
});
