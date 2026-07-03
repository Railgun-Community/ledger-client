/**
 * APDU script parser.
 *
 * Parses hex APDU command lines from string data.
 * Platform-agnostic — no file system dependencies.
 */

import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';

/**
 * Clean a line of hex: trim whitespace, collapse gaps, strip 0x prefix.
 */
function cleanHexLine(line: string): string {
  return line.trim().replace(/\s+/g, '').replace(/^0x/i, '');
}

/**
 * Parse a cleaned hex string into APDU bytes.
 * Returns undefined for invalid or too-short commands.
 */
export function parseCapdu(hex: string): Uint8Array | undefined {
  if (!/^[0-9a-fA-F]+$/.test(hex)) return undefined;
  if (hex.length % 2 !== 0) return undefined;
  const capdu = hexToBytes(hex);
  if (capdu.length < 5) return undefined;
  return capdu;
}

/**
 * Yield individual APDU commands from an APDU script string.
 * Skips blank lines and lines starting with '#'.
 */
export function* parseApduScript(data: string): Generator<{ hex: string; lineNumber: number; bytes: Uint8Array }> {
  const lines = data.split(/\r?\n/);
  let lineNumber = 0;

  for (const line of lines) {
    lineNumber++;
    const cleaned = cleanHexLine(line);
    if (!cleaned || cleaned.startsWith('#')) continue;
    const bytes = parseCapdu(cleaned);
    if (!bytes) continue;
    yield { hex: cleaned, lineNumber, bytes };
  }
}

/**
 * Count valid APDU command lines in an APDU script string.
 */
export function countApduCommands(data: string): number {
  let count = 0;
  for (const _ of parseApduScript(data)) {
    count++;
  }
  return count;
}

/**
 * Extract the app name from the first APDU CREATE_APP command.
 *
 * The first command in a Ledger APDU install script is typically:
 *   E0 00 00 00 Lc [flags] [nameLen] [name bytes...]
 *
 * The name is a length-prefixed UTF-8 string starting at byte offset 6
 * (after CLA INS P1 P2 Lc flags).
 *
 * Returns undefined if the format doesn't match.
 */
export function extractAppName(data: string): string | undefined {
  for (const { bytes } of parseApduScript(data)) {
    // First command only
    if (bytes.length < 8) return undefined;
    // nameLen is at offset 6 (after CLA INS P1 P2 Lc flags)
    const nameLen = bytes[6];
    if (nameLen === undefined || nameLen === 0 || 7 + nameLen > bytes.length) {
      return undefined;
    }
    return new TextDecoder().decode(bytes.subarray(7, 7 + nameLen));
  }
  return undefined;
}

/**
 * APDU install sub-command bytes used in BOLOS installer protocol.
 */
const SUB_CMD_LOAD = 0x06;
const SUB_CMD_PARAMS = 0x0b;

/**
 * Extract the concatenated LOAD segment data and PARAMS fields from an APDU script.
 * Shared helper for the hash computation functions.
 */
function extractCodeAndParams(data: string): {
  codeData: Uint8Array;
  codeLength: number;
  dataLength: number;
  installParamsLength: number;
} | undefined {
  const chunks: Uint8Array[] = [];
  let codeLength = 0;
  let dataLength = 0;
  let installParamsLength = 0;

  for (const { bytes } of parseApduScript(data)) {
    if (bytes.length >= 7 && bytes[5] === SUB_CMD_PARAMS) {
      // PARAMS payload (after subcmd byte): >BIIIII or >IIIII
      const params = bytes.subarray(6);
      if (params.length >= 21) {
        // With api_level: B(1) + code_length(4) + data_length(4) + install_params_length(4) + flags(4) + boot(4)
        const pdv = new DataView(params.buffer, params.byteOffset, params.byteLength);
        codeLength = pdv.getUint32(1, false);
        dataLength = pdv.getUint32(5, false);
        installParamsLength = pdv.getUint32(9, false);
      } else if (params.length >= 17) {
        // Legacy (no api_level): code_length(4) + data_length(4) + install_params_length(4) + flags(4) + boot(4)
        const pdv = new DataView(params.buffer, params.byteOffset, params.byteLength);
        codeLength = pdv.getUint32(0, false);
        dataLength = pdv.getUint32(4, false);
        installParamsLength = pdv.getUint32(8, false);
      }
    }
    if (bytes.length >= 9 && bytes[5] === SUB_CMD_LOAD) {
      chunks.push(bytes.subarray(8));
    }
  }

  if (chunks.length === 0) return undefined;

  let totalLen = 0;
  for (const c of chunks) totalLen += c.length;
  const codeData = new Uint8Array(totalLen);
  let offset = 0;
  for (const c of chunks) {
    codeData.set(c, offset);
    offset += c.length;
  }

  return { codeData, codeLength, dataLength, installParamsLength };
}

/**
 * Compute the SHA-256 hash of all code data segments in an APDU install script.
 *
 * BOLOS LOAD commands have sub-command 0x06 with format:
 *   CLA(1) INS(1) P1(1) P2(1) Lc(1) 0x06 offset(2) code_data...
 *
 * The code data starts at byte 8 (after the 3-byte payload header).
 * This is a simple hash of ALL loaded data (code + data + install_params).
 *
 * Returns hex string of SHA-256, or undefined if no code segments found.
 */
export function computeCodeHash(data: string): string | undefined {
  const result = extractCodeAndParams(data);
  if (!result) return undefined;
  return bytesToHex(sha256(result.codeData));
}

/**
 * Compute the BOLOS "Code ID" shown on the Ledger device during install.
 *
 * The loaded APDU data packs three regions sequentially in LOAD (0x06) segments:
 *   code[code_length] + data[data_length] + install_params[install_params_length]
 *
 * The Code ID is SHA-256 of the code + data region (excluding install_params):
 *   SHA-256( loaded_data[0 .. code_length + data_length] )
 *
 * The region sizes come from the PARAMS (0x0b) sub-command payload.
 *
 * Returns hex string of SHA-256, or undefined if no code segments found.
 */
export function computeCodeId(data: string): string | undefined {
  const result = extractCodeAndParams(data);
  if (!result) return undefined;

  const { codeData, codeLength, dataLength } = result;
  const regionSize = codeLength + dataLength;

  // If we couldn't parse PARAMS or region covers all data, hash everything
  if (regionSize === 0 || regionSize >= codeData.length) {
    return bytesToHex(sha256(codeData));
  }

  return bytesToHex(sha256(codeData.subarray(0, regionSize)));
}

/**
 * Compute the BOLOS "Application full hash" following the ledgerblue algorithm.
 *
 * Per `hexLoader.py`, the app identifier shown on the Ledger device during
 * install is:
 *
 *   SHA-256( targetId_BE32 + createAppParams + code_data_chunks )
 *
 * Where:
 * - targetId is the 4-byte big-endian device target ID (e.g. 0x33100004)
 * - createAppParams is the payload of the PARAMS (0x0b) sub-command,
 *   excluding the sub-command byte itself
 * - code_data_chunks are the raw code bytes from LOAD (0x06) segments,
 *   each starting at byte offset 8 (after CLA INS P1 P2 Lc sub offset_hi offset_lo)
 *
 * Returns hex string of SHA-256, or undefined if no code segments found.
 */
export function computeAppHash(
  data: string,
  targetId: number,
): string | undefined {
  const parts: Uint8Array[] = [];

  // 1. Target ID as big-endian 32-bit — only for version >= 4 (targetId & 0xF > 3)
  if ((targetId & 0xf) > 3) {
    const tidBuf = new Uint8Array(4);
    new DataView(tidBuf.buffer).setUint32(0, targetId, false);
    parts.push(tidBuf);
  }

  // 2. createAppParams: PARAMS (0x0b) payload minus the sub-command byte
  let hasCode = false;
  for (const { bytes } of parseApduScript(data)) {
    if (bytes.length >= 7 && bytes[5] === SUB_CMD_PARAMS) {
      parts.push(bytes.subarray(6)); // skip CLA INS P1 P2 Lc SUB
      break;
    }
  }

  // 3. Code data chunks from LOAD (0x06) segments
  for (const { bytes } of parseApduScript(data)) {
    if (bytes.length < 9 || bytes[5] !== SUB_CMD_LOAD) continue;
    parts.push(bytes.subarray(8));
    hasCode = true;
  }

  if (!hasCode) return undefined;

  let totalLen = 0;
  for (const p of parts) totalLen += p.length;
  const all = new Uint8Array(totalLen);
  let offset = 0;
  for (const p of parts) {
    all.set(p, offset);
    offset += p.length;
  }
  return bytesToHex(sha256(all));
}
