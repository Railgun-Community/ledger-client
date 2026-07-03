/**
 * EIP-7702 delegate address whitelist.
 *
 * Maintains a set of approved delegate contract addresses for EIP-7702
 * authorization signing. Addresses are validated on add, stored normalized
 * (lowercased, 0x-prefixed), and can be checked before signing.
 *
 * Hardcoded defaults include known RAILGUN contract addresses.
 * Runtime overrides allow adding application-specific delegates.
 */

import { HWError, HWErrorCode } from '../errors.js';

/**
 * A delegate entry in the whitelist.
 * label is for display purposes only (device UI, logs).
 */
export type DelegateEntry = {
  /** 0x-prefixed, lowercase, 20-byte hex address. */
  readonly address: string;
  /** Chain ID this delegate is valid on (0n = any chain). */
  readonly chainId: bigint;
  /** Human-readable label for logging/display. */
  readonly label: string;
};

// ─── Default RAILGUN delegate addresses ─────────────────────────────────────
// TODO: Replace with actual RAILGUN contract addresses before production.
// These are placeholder addresses for development.

const DEFAULT_DELEGATES: readonly DelegateEntry[] = [
  // Example: RAILGUN proxy delegate on Ethereum mainnet
  // {
  //   address: '0x...',
  //   chainId: 1n,
  //   label: 'RAILGUN Proxy Delegate (Mainnet)',
  // },
] as const;

/**
 * Normalize and validate a hex address.
 * Returns lowercased 0x-prefixed 40-char hex.
 */
function normalizeAddress(address: string): string {
  const hex = address.startsWith('0x') ? address.slice(2) : address;
  if (hex.length !== 40 || !/^[0-9a-fA-F]{40}$/.test(hex)) {
    throw new HWError(
      HWErrorCode.VALIDATION_PUBLIC_INPUTS,
      `Invalid delegate address: expected 20-byte hex, got "${address}"`,
    );
  }
  return `0x${hex.toLowerCase()}`;
}

/**
 * Manages a set of whitelisted delegate addresses for EIP-7702 signing.
 */
export class DelegateWhitelist {
  private readonly _entries: Map<string, DelegateEntry> = new Map();

  constructor(additionalDelegates?: readonly DelegateEntry[]) {
    // Load defaults
    for (const entry of DEFAULT_DELEGATES) {
      this._addEntry(entry);
    }
    // Load runtime overrides
    if (additionalDelegates) {
      for (const entry of additionalDelegates) {
        this._addEntry(entry);
      }
    }
  }

  /**
   * Check if a delegate address is whitelisted for the given chain.
   * chainId=0n matches any chain.
   */
  isWhitelisted(address: string, chainId: bigint): boolean {
    const normalized = normalizeAddress(address);
    const key = this._key(normalized, chainId);
    // Check exact match first
    if (this._entries.has(key)) {
      return true;
    }
    // Check any-chain wildcard
    if (chainId !== 0n && this._entries.has(this._key(normalized, 0n))) {
      return true;
    }
    return false;
  }

  /**
   * Get the entry for a whitelisted address, or undefined if not whitelisted.
   */
  getEntry(address: string, chainId: bigint): DelegateEntry | undefined {
    const normalized = normalizeAddress(address);
    const key = this._key(normalized, chainId);
    return this._entries.get(key) ?? this._entries.get(this._key(normalized, 0n));
  }

  /**
   * Add a delegate to the whitelist at runtime.
   */
  add(entry: DelegateEntry): void {
    this._addEntry(entry);
  }

  /**
   * Remove a delegate from the whitelist.
   */
  remove(address: string, chainId: bigint): boolean {
    const normalized = normalizeAddress(address);
    return this._entries.delete(this._key(normalized, chainId));
  }

  /**
   * Get all whitelisted entries.
   */
  entries(): readonly DelegateEntry[] {
    return [...this._entries.values()];
  }

  /**
   * Number of entries in the whitelist.
   */
  get size(): number {
    return this._entries.size;
  }

  // ─── Private ────────────────────────────────────────────────────────────────

  private _addEntry(entry: DelegateEntry): void {
    const normalized = normalizeAddress(entry.address);
    const key = this._key(normalized, entry.chainId);
    this._entries.set(key, {
      address: normalized,
      chainId: entry.chainId,
      label: entry.label,
    });
  }

  private _key(normalizedAddress: string, chainId: bigint): string {
    return `${normalizedAddress}:${String(chainId)}`;
  }
}
