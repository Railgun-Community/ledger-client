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

  it('maps the RAILGUN app state SW (0xb007) to a clear message', () => {
    expect(StatusWord.RAILGUN_CLEAR_SIGN_STATE).toBe(StatusWord.BAD_STATE);
    const err = statusWordToHWError(StatusWord.BAD_STATE);
    expect(err.code).toBe(HWErrorCode.APDU_STATUS_ERROR);
    expect(err.message).toContain('0xb007');
    expect(err.message).toContain('CLEAR_SIGN');
  });

  it('names each RAILGUN app status word in its message', () => {
    // src/sw.h of the RAILGUN app.
    const cases: [number, string][] = [
      [0x6a80, '0x6a80'],
      [0x6a86, '0x6a86'],
      [0x6a87, '0x6a87'],
      [0x6d00, '0x6d00'],
      [0x6e00, '0x6e00'],
      [0xb008, '0xb008'],
    ];
    for (const [sw, text] of cases) {
      const err = statusWordToHWError(sw);
      expect(err.code).toBe(HWErrorCode.APDU_STATUS_ERROR);
      expect(err.message).toContain(text);
      expect(err.message).not.toMatch(/^APDU error/);
    }
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
