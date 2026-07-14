/**
 * Tests for the Node HID transport.
 */

import { describe, it, expect } from 'vitest';
import { NodeHIDTransport } from '../../src/core/transport/nodehid-transport.js';

describe('NodeHIDTransport', () => {
  it('reports its own transport type (not mislabeled as webhid)', () => {
    const transport = new NodeHIDTransport();
    expect(transport.type).toBe('nodehid');
    expect(transport.isConnected()).toBe(false);
  });
});
