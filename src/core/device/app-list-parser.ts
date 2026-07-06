/**
 * Shared LIST_APPS page parser.
 *
 * The dashboard LIST_APPS command returns installed apps one page at a time.
 * The device manager (app inventory) and the installer (verification logging)
 * both parsed this wire format inline; keeping the layout in one place is the
 * single source of truth so the two cannot drift.
 *
 * Page payload (BOLOS SDK 2.x — Nano S Plus / Stax / Flex): a format-version
 * byte, then per entry:
 *   entryLength(1) sizeInBlocks(2,BE) flags(2) codeHash(32) fullHash(32) nameLen(1) name(N)
 *
 * entryLength is informational: fields are read sequentially, matching the
 * Ledger DMK, which ignores it for offset control. Parsing stops cleanly at
 * the first truncated entry.
 */

/**
 * Fixed per-entry header preceding the length-prefixed name:
 * entryLength(1) + sizeInBlocks(2) + flags(2) + codeHash(32) + fullHash(32).
 */
const ENTRY_HEADER_BYTES = 69;

/** One parsed LIST_APPS entry, fields left un-encoded for the caller. */
export interface RawAppEntry {
  /** Code size in flash blocks (the sizeInBlocks field). */
  readonly sizeInBlocks: number;
  /** 32-byte code hash (view into the page buffer). */
  readonly codeHash: Uint8Array;
  /** 32-byte full hash of code + data (view into the page buffer). */
  readonly fullHash: Uint8Array;
  /** App name with BOLOS trailing-null padding stripped. */
  readonly name: string;
}

/**
 * Parse one LIST_APPS page payload — including its leading format-version
 * byte — into raw entries.
 */
export function parseAppListPage(data: Uint8Array): RawAppEntry[] {
  const entries: RawAppEntry[] = [];
  let offset = 0;

  // Skip the format-version byte.
  if (data.length < 1) return entries;
  offset += 1;

  while (offset + ENTRY_HEADER_BYTES <= data.length) {
    offset += 1; // skip entryLength (informational)

    const sizeInBlocks = (data[offset]! << 8) | data[offset + 1]!;
    offset += 2;
    offset += 2; // skip flags

    const codeHash = data.subarray(offset, offset + 32);
    offset += 32;
    const fullHash = data.subarray(offset, offset + 32);
    offset += 32;

    if (offset >= data.length) break;
    const nameLen = data[offset]!;
    offset += 1;
    if (offset + nameLen > data.length) break;

    // BOLOS names are null-terminated — strip trailing nulls.
    const name = new TextDecoder()
      .decode(data.subarray(offset, offset + nameLen))
      .replace(/\0+$/g, '');
    offset += nameLen;

    entries.push({ sizeInBlocks, codeHash, fullHash, name });
  }

  return entries;
}
