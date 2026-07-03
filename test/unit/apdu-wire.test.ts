/**
 * Tests for APDU wire-format serialization and deserialization.
 */

import { describe, it, expect } from 'vitest';
import {
  serializeApdu,
  deserializeApduResponse,
  formatStatusWord,
} from '../../src/core/transport/apdu-wire.js';
import { HWError } from '../../src/core/errors.js';
import type { ApduCommand } from '../../src/core/transport/types.js';

describe('serializeApdu', () => {
  it('serializes command without data', () => {
    const cmd: ApduCommand = { cla: 0xe0, ins: 0x01, p1: 0x00, p2: 0x00 };
    const result = serializeApdu(cmd);
    expect(result).toEqual(new Uint8Array([0xe0, 0x01, 0x00, 0x00]));
  });

  it('serializes command with data', () => {
    const data = new Uint8Array([0xaa, 0xbb, 0xcc]);
    const cmd: ApduCommand = { cla: 0xe1, ins: 0x03, p1: 0x00, p2: 0x00, data };
    const result = serializeApdu(cmd);
    expect(result).toEqual(
      new Uint8Array([0xe1, 0x03, 0x00, 0x00, 0x03, 0xaa, 0xbb, 0xcc]),
    );
  });

  it('serializes command with empty data as no-data', () => {
    const cmd: ApduCommand = {
      cla: 0xe0,
      ins: 0x01,
      p1: 0x00,
      p2: 0x00,
      data: new Uint8Array(0),
    };
    const result = serializeApdu(cmd);
    expect(result).toEqual(new Uint8Array([0xe0, 0x01, 0x00, 0x00]));
  });

  it('includes Lc byte with data length', () => {
    const data = new Uint8Array(32).fill(0xff);
    const cmd: ApduCommand = { cla: 0xe1, ins: 0x03, p1: 0x00, p2: 0x00, data };
    const result = serializeApdu(cmd);
    expect(result[4]).toBe(32); // Lc
    expect(result.length).toBe(5 + 32);
  });

  it('rejects data > 255 bytes', () => {
    const data = new Uint8Array(256);
    const cmd: ApduCommand = { cla: 0xe0, ins: 0x01, p1: 0, p2: 0, data };
    expect(() => serializeApdu(cmd)).toThrow(HWError);
  });
});

describe('deserializeApduResponse', () => {
  it('parses response with data + status word', () => {
    const raw = new Uint8Array([0x11, 0x22, 0x33, 0x90, 0x00]);
    const result = deserializeApduResponse(raw);
    expect(result.statusWord).toBe(0x9000);
    expect(result.data).toEqual(new Uint8Array([0x11, 0x22, 0x33]));
  });

  it('parses status-word-only response (no data)', () => {
    const raw = new Uint8Array([0x69, 0x85]);
    const result = deserializeApduResponse(raw);
    expect(result.statusWord).toBe(0x6985);
    expect(result.data.length).toBe(0);
  });

  it('rejects response shorter than 2 bytes', () => {
    expect(() => deserializeApduResponse(new Uint8Array([0x90]))).toThrow(HWError);
    expect(() => deserializeApduResponse(new Uint8Array([]))).toThrow(HWError);
  });
});

describe('formatStatusWord', () => {
  it('formats 0x9000', () => {
    expect(formatStatusWord(0x9000)).toBe('0x9000');
  });

  it('formats 0x6985', () => {
    expect(formatStatusWord(0x6985)).toBe('0x6985');
  });

  it('pads short values', () => {
    expect(formatStatusWord(0x00)).toBe('0x0000');
  });
});
