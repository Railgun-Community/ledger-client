/**
 * Tests for transport factory.
 */

import { describe, it, expect } from 'vitest';
import { createTransport } from '../../src/core/transport/transport-factory.js';
import { WebHIDTransport } from '../../src/core/transport/webhid-transport.js';
import { WebBLETransport } from '../../src/core/transport/web-ble-transport.js';
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

  it('creates a BLE transport', () => {
    const transport = createTransport({ type: 'ble' });
    expect(transport).toBeInstanceOf(WebBLETransport);
    expect(transport.type).toBe('ble');
  });

  it('throws for nodehid, directing to direct import or transportFactory', () => {
    expect(() => createTransport({ type: 'nodehid' })).toThrow(HWError);
    expect(() => createTransport({ type: 'nodehid' })).toThrow(/Node HID|transportFactory/);
  });
});
