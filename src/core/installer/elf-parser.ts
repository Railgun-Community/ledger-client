/**
 * ELF target ID extractor.
 *
 * Extracts the Ledger target ID from a compiled .elf binary.
 * Uses string scanning — same heuristic as ledgerhw-signer.
 * Platform-agnostic — accepts Uint8Array, no file system dependencies.
 */

/**
 * Extract printable ASCII strings (length >= minLength) from binary data.
 */
function extractAsciiStrings(data: Uint8Array, minLength = 4): string[] {
  const out: string[] = [];
  let current = '';

  for (const byte of data) {
    if (byte >= 32 && byte <= 126) {
      current += String.fromCharCode(byte);
    } else {
      if (current.length >= minLength) {
        out.push(current);
      }
      current = '';
    }
  }

  if (current.length >= minLength) {
    out.push(current);
  }

  return out;
}

/**
 * Find a hex target ID (e.g. 0x33100004) in a string.
 */
function findHexId(text: string): string | undefined {
  const matches = text.match(/0x[0-9a-fA-F]{8}/g);
  return matches?.[0];
}

/**
 * Try to extract the Ledger target ID from ELF binary data.
 *
 * Scans for ASCII strings containing "target" or known metadata prefixes
 * and extracts 0x-prefixed 8-digit hex IDs.
 *
 * Returns undefined if no target ID is found.
 */
export function tryGetTargetIdFromElf(elfData: Uint8Array): number | undefined {
  const strings = extractAsciiStrings(elfData);

  // First pass: look for strings explicitly mentioning "target"
  for (const text of strings) {
    if (text.toLowerCase().includes('target') || text.toLowerCase().includes('ledger.target_id')) {
      const hex = findHexId(text);
      if (hex !== undefined) return Number.parseInt(hex, 16);
    }
  }

  // Second pass: any hex ID will do
  for (const text of strings) {
    const hex = findHexId(text);
    if (hex !== undefined) return Number.parseInt(hex, 16);
  }

  return undefined;
}
