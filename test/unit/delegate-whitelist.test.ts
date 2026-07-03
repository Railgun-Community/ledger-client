/**
 * Unit tests for DelegateWhitelist.
 *
 * Tests address normalization, chain-aware matching, wildcard (chainId=0),
 * add/remove operations, and validation errors.
 */

import { describe, it, expect } from 'vitest';
import { DelegateWhitelist } from '../../src/core/signers/delegate-whitelist.js';
import type { DelegateEntry } from '../../src/core/signers/delegate-whitelist.js';
import { HWError } from '../../src/core/errors.js';

const ADDR_A = '0x4Cd241E8d1510e30b2076397afC7508Ae59C66c9';
const ADDR_B = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
const ADDR_A_LOWER = '0x4cd241e8d1510e30b2076397afc7508ae59c66c9';

function entry(address: string, chainId: bigint, label: string): DelegateEntry {
  return { address, chainId, label };
}

describe('DelegateWhitelist', () => {
  describe('constructor', () => {
    it('creates empty whitelist by default', () => {
      const wl = new DelegateWhitelist();
      expect(wl.size).toBe(0);
      expect(wl.entries()).toEqual([]);
    });

    it('loads additional delegates', () => {
      const wl = new DelegateWhitelist([
        entry(ADDR_A, 1n, 'Test A'),
        entry(ADDR_B, 0n, 'Test B'),
      ]);
      expect(wl.size).toBe(2);
    });
  });

  describe('isWhitelisted', () => {
    it('returns true for exact chain match', () => {
      const wl = new DelegateWhitelist([entry(ADDR_A, 1n, 'Mainnet')]);
      expect(wl.isWhitelisted(ADDR_A, 1n)).toBe(true);
    });

    it('returns false for wrong chain', () => {
      const wl = new DelegateWhitelist([entry(ADDR_A, 1n, 'Mainnet')]);
      expect(wl.isWhitelisted(ADDR_A, 42n)).toBe(false);
    });

    it('wildcard chainId=0 matches any chain', () => {
      const wl = new DelegateWhitelist([entry(ADDR_A, 0n, 'Any chain')]);
      expect(wl.isWhitelisted(ADDR_A, 1n)).toBe(true);
      expect(wl.isWhitelisted(ADDR_A, 137n)).toBe(true);
      expect(wl.isWhitelisted(ADDR_A, 0n)).toBe(true);
    });

    it('returns false for unlisted address', () => {
      const wl = new DelegateWhitelist([entry(ADDR_A, 0n, 'A')]);
      expect(wl.isWhitelisted(ADDR_B, 1n)).toBe(false);
    });

    it('normalizes address case', () => {
      const wl = new DelegateWhitelist([entry(ADDR_A, 1n, 'Test')]);
      expect(wl.isWhitelisted(ADDR_A_LOWER, 1n)).toBe(true);
      expect(wl.isWhitelisted(ADDR_A.toUpperCase().replace('0X', '0x'), 1n)).toBe(true);
    });

    it('accepts address without 0x prefix', () => {
      const wl = new DelegateWhitelist([entry(ADDR_A, 1n, 'Test')]);
      expect(wl.isWhitelisted(ADDR_A.slice(2), 1n)).toBe(true);
    });
  });

  describe('getEntry', () => {
    it('returns entry for exact match', () => {
      const wl = new DelegateWhitelist([entry(ADDR_A, 1n, 'Mainnet')]);
      const e = wl.getEntry(ADDR_A, 1n);
      expect(e).toBeDefined();
      expect(e!.label).toBe('Mainnet');
      expect(e!.address).toBe(ADDR_A_LOWER);
    });

    it('returns wildcard entry for non-exact chain', () => {
      const wl = new DelegateWhitelist([entry(ADDR_A, 0n, 'Any')]);
      const e = wl.getEntry(ADDR_A, 42n);
      expect(e).toBeDefined();
      expect(e!.chainId).toBe(0n);
    });

    it('returns undefined for missing address', () => {
      const wl = new DelegateWhitelist();
      expect(wl.getEntry(ADDR_A, 1n)).toBeUndefined();
    });
  });

  describe('add', () => {
    it('adds entry at runtime', () => {
      const wl = new DelegateWhitelist();
      expect(wl.size).toBe(0);
      wl.add(entry(ADDR_A, 1n, 'Added'));
      expect(wl.size).toBe(1);
      expect(wl.isWhitelisted(ADDR_A, 1n)).toBe(true);
    });

    it('overwrites existing entry for same address+chain', () => {
      const wl = new DelegateWhitelist([entry(ADDR_A, 1n, 'Old')]);
      wl.add(entry(ADDR_A, 1n, 'New'));
      expect(wl.size).toBe(1);
      expect(wl.getEntry(ADDR_A, 1n)!.label).toBe('New');
    });

    it('allows same address on different chains', () => {
      const wl = new DelegateWhitelist();
      wl.add(entry(ADDR_A, 1n, 'Mainnet'));
      wl.add(entry(ADDR_A, 137n, 'Polygon'));
      expect(wl.size).toBe(2);
      expect(wl.isWhitelisted(ADDR_A, 1n)).toBe(true);
      expect(wl.isWhitelisted(ADDR_A, 137n)).toBe(true);
      expect(wl.isWhitelisted(ADDR_A, 42n)).toBe(false);
    });
  });

  describe('remove', () => {
    it('removes existing entry and returns true', () => {
      const wl = new DelegateWhitelist([entry(ADDR_A, 1n, 'Test')]);
      expect(wl.remove(ADDR_A, 1n)).toBe(true);
      expect(wl.size).toBe(0);
      expect(wl.isWhitelisted(ADDR_A, 1n)).toBe(false);
    });

    it('returns false for non-existent entry', () => {
      const wl = new DelegateWhitelist();
      expect(wl.remove(ADDR_A, 1n)).toBe(false);
    });

    it('does not affect other chains for same address', () => {
      const wl = new DelegateWhitelist([
        entry(ADDR_A, 1n, 'Mainnet'),
        entry(ADDR_A, 137n, 'Polygon'),
      ]);
      wl.remove(ADDR_A, 1n);
      expect(wl.size).toBe(1);
      expect(wl.isWhitelisted(ADDR_A, 137n)).toBe(true);
    });
  });

  describe('entries', () => {
    it('returns all entries as array', () => {
      const wl = new DelegateWhitelist([
        entry(ADDR_A, 1n, 'A'),
        entry(ADDR_B, 0n, 'B'),
      ]);
      const all = wl.entries();
      expect(all).toHaveLength(2);
      expect(all.map(e => e.label).sort()).toEqual(['A', 'B']);
    });

    it('returns empty array for empty whitelist', () => {
      expect(new DelegateWhitelist().entries()).toEqual([]);
    });

    it('entries are normalized', () => {
      const wl = new DelegateWhitelist([entry(ADDR_A, 1n, 'Test')]);
      const [e] = wl.entries();
      expect(e!.address).toBe(ADDR_A_LOWER);
    });
  });

  describe('validation', () => {
    it('rejects invalid hex address', () => {
      const wl = new DelegateWhitelist();
      expect(() => wl.add(entry('0xZZZ', 1n, 'Bad'))).toThrow(HWError);
    });

    it('rejects short address', () => {
      const wl = new DelegateWhitelist();
      expect(() => wl.add(entry('0x1234', 1n, 'Short'))).toThrow(HWError);
    });

    it('rejects address longer than 20 bytes', () => {
      const wl = new DelegateWhitelist();
      expect(() => wl.add(entry('0x' + 'aa'.repeat(21), 1n, 'Long'))).toThrow(HWError);
    });

    it('rejects invalid address in isWhitelisted', () => {
      const wl = new DelegateWhitelist();
      expect(() => wl.isWhitelisted('bad', 1n)).toThrow(HWError);
    });

    it('rejects invalid address in getEntry', () => {
      const wl = new DelegateWhitelist();
      expect(() => wl.getEntry('garbage', 1n)).toThrow(HWError);
    });

    it('rejects invalid address in remove', () => {
      const wl = new DelegateWhitelist();
      expect(() => wl.remove('0x', 1n)).toThrow(HWError);
    });
  });
});
