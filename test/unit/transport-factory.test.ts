/**
 * Tests for transport factory.
 */

import { describe, it, expect } from 'vitest';
import { createTransport } from '../../src/core/transport/transport-factory.js';
import { WebHIDTransport } from '../../src/core/transport/webhid-transport.js';
import { HWError } from '../../src/core/errors.js';

describe('createTransport', () => {
  it('defaults to WebHID transport', () => {
    const transport = createTransport();
    expect(transport).toBeInstanceOf(WebHIDTransport);
    expect(transport.type).toBe('webhid');
  });

  it('creates WebHID transport with explicit config', () => {
    const transport = createTransport({ type: 'webhid', timeout: 5000 });
    expect(transport).toBeInstanceOf(WebHIDTransport);
  });

  it('throws for BLE (not implemented)', () => {
    expect(() => createTransport({ type: 'ble' })).toThrow(HWError);
  });
});
