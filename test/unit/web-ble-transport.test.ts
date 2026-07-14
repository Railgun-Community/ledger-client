/**
 * Tests for the Web BLE transport.
 */

import { describe, it, expect } from 'vitest';
import { WebBLETransport } from '../../src/core/transport/web-ble-transport.js';

describe('WebBLETransport', () => {
  it('reports its transport type and starts disconnected', () => {
    const transport = new WebBLETransport();
    expect(transport.type).toBe('ble');
    expect(transport.isConnected()).toBe(false);
  });
});
