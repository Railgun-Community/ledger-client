/**
 * Tests for Ethereum signature response parsing (M4 — r/s range checks).
 */

import { describe, it, expect } from 'vitest';
import { parseEthereumSignatureResponse } from '../../src/core/transport/apdu.js';

function resp(yParity: number, rByte: number, sByte: number): Uint8Array {
  const d = new Uint8Array(65);
  d[0] = yParity;
  d.fill(rByte, 1, 33);
  d.fill(sByte, 33, 65);
  return d;
}

describe('parseEthereumSignatureResponse', () => {
  it('accepts an in-range signature', () => {
    const parsed = parseEthereumSignatureResponse(resp(1, 0xaa, 0xbb));
    expect(parsed.yParity).toBe(1);
    expect(parsed.r).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('rejects r = 0', () => {
    expect(() => parseEthereumSignatureResponse(resp(0, 0x00, 0xbb))).toThrow(/out of range/);
  });

  it('rejects s = 0', () => {
    expect(() => parseEthereumSignatureResponse(resp(0, 0xaa, 0x00))).toThrow(/out of range/);
  });

  it('rejects an invalid yParity', () => {
    expect(() => parseEthereumSignatureResponse(resp(2, 0xaa, 0xbb))).toThrow(/yParity/);
  });

  it('rejects a wrong-length response', () => {
    expect(() => parseEthereumSignatureResponse(new Uint8Array(64))).toThrow(/65 bytes/);
  });
});
