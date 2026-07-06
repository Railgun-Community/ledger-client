/**
 * Tests for the shared LIST_APPS page parser.
 *
 * Exercises the 69-byte entry stride directly: field extraction, name
 * null-stripping, multi-entry pages, empty pages, and clean truncation.
 */

import { describe, it, expect } from 'vitest';
import { parseAppListPage } from '../../src/core/device/app-list-parser.js';

interface EntryOpts {
  sizeInBlocks?: number;
  codeHash?: Uint8Array;
  fullHash?: Uint8Array;
  /** Override the encoded name length prefix (to build truncated entries). */
  nameLenOverride?: number;
}

/**
 * Build one LIST_APPS entry:
 *   entryLength(1) sizeInBlocks(2,BE) flags(2) codeHash(32) fullHash(32) nameLen(1) name(N)
 */
function buildEntry(name: string, opts: EntryOpts = {}): Uint8Array {
  const sizeInBlocks = opts.sizeInBlocks ?? 0;
  const codeHash = opts.codeHash ?? new Uint8Array(32).fill(0xaa);
  const fullHash = opts.fullHash ?? new Uint8Array(32).fill(0xbb);
  const nameBytes = new TextEncoder().encode(name);

  const body = new Uint8Array(2 + 2 + 32 + 32 + 1 + nameBytes.length);
  let o = 0;
  body[o++] = (sizeInBlocks >>> 8) & 0xff;
  body[o++] = sizeInBlocks & 0xff;
  o += 2; // flags — zeroed
  body.set(codeHash.subarray(0, 32), o);
  o += 32;
  body.set(fullHash.subarray(0, 32), o);
  o += 32;
  body[o++] = opts.nameLenOverride ?? nameBytes.length;
  body.set(nameBytes, o);

  const entry = new Uint8Array(1 + body.length);
  entry[0] = body.length; // entryLength (informational)
  entry.set(body, 1);
  return entry;
}

/** Wrap entries in a page with the leading format-version byte. */
function buildPage(...entries: Uint8Array[]): Uint8Array {
  let total = 1;
  for (const e of entries) total += e.length;
  const buf = new Uint8Array(total);
  buf[0] = 0x01; // format version
  let offset = 1;
  for (const e of entries) {
    buf.set(e, offset);
    offset += e.length;
  }
  return buf;
}

describe('parseAppListPage', () => {
  it('parses a single entry and keeps codeHash distinct from fullHash', () => {
    const codeHash = new Uint8Array(32).fill(0x11);
    const fullHash = new Uint8Array(32).fill(0x22);
    const page = buildPage(
      buildEntry('Ethereum', { sizeInBlocks: 0x1234, codeHash, fullHash }),
    );

    const [entry, ...rest] = parseAppListPage(page);
    expect(rest).toHaveLength(0);
    expect(entry!.name).toBe('Ethereum');
    expect(entry!.sizeInBlocks).toBe(0x1234);
    expect([...entry!.codeHash]).toEqual([...codeHash]);
    expect([...entry!.fullHash]).toEqual([...fullHash]);
    // Regression guard: the two hashes must not be conflated.
    expect([...entry!.codeHash]).not.toEqual([...entry!.fullHash]);
  });

  it('parses multiple entries in one page', () => {
    const page = buildPage(
      buildEntry('Ethereum', { sizeInBlocks: 1024 }),
      buildEntry('RAILGUN', { sizeInBlocks: 2048 }),
    );

    const entries = parseAppListPage(page);
    expect(entries.map((e) => e.name)).toEqual(['Ethereum', 'RAILGUN']);
    expect(entries.map((e) => e.sizeInBlocks)).toEqual([1024, 2048]);
  });

  it('strips BOLOS trailing null padding from names', () => {
    const page = buildPage(buildEntry('BOLOS\0\0\0'));
    const [entry] = parseAppListPage(page);
    expect(entry!.name).toBe('BOLOS');
  });

  it('returns an empty list for an empty payload', () => {
    expect(parseAppListPage(new Uint8Array(0))).toEqual([]);
  });

  it('returns an empty list for a format-version byte with no entries', () => {
    expect(parseAppListPage(new Uint8Array([0x01]))).toEqual([]);
  });

  it('stops cleanly at a truncated trailing entry', () => {
    const good = buildEntry('Ethereum');
    // Append a partial entry (fewer than the 69-byte header) after a full one.
    const page = buildPage(good);
    const truncated = new Uint8Array(page.length + 10);
    truncated.set(page, 0);
    truncated.fill(0xcc, page.length); // 10 stray bytes — not a full entry

    const entries = parseAppListPage(truncated);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.name).toBe('Ethereum');
  });

  it('stops when a name length prefix overflows the payload', () => {
    // Claim a 200-byte name but supply only 4 bytes of it.
    const page = buildPage(buildEntry('Eth', { nameLenOverride: 200 }));
    expect(parseAppListPage(page)).toHaveLength(0);
  });
});
