/**
 * Device manager.
 *
 * High-level operations on a Ledger device: query info, list apps,
 * open/close apps. All operations go through an HWTransport.
 *
 * Invariants:
 * - All methods validate APDU responses before returning
 * - Transport errors propagate as HWError
 * - No state mutation — pure query/command interface
 */

import type { HWTransport } from '../transport/types.js';
import { StatusWord } from '../transport/types.js';
import type { DeviceInfo, AppInfo, ActiveAppInfo } from './types.js';
import { HWError, HWErrorCode } from '../errors.js';
import {
  buildDashboardGetVersion,
  buildGetAppAndVersion,
  buildOpenApp,
  buildCloseApp,
  buildListApps,
} from '../transport/dashboard-commands.js';
import { validateApduResponse } from '../../validation/apdu-response.js';

/**
 * Query device firmware information.
 *
 * Must be called when the dashboard is active (no app open),
 * or some devices may return a different response format.
 */
export async function getDeviceInfo(transport: HWTransport): Promise<DeviceInfo> {
  const response = await transport.send(buildDashboardGetVersion());
  validateApduResponse(response);

  const data = response.data;
  if (data.length < 9) {
    throw new HWError(
      HWErrorCode.APDU_INVALID_RESPONSE,
      `GET_VERSION response too short: ${String(data.length)} bytes`,
    );
  }

  // Parse: targetId (4B big-endian)
  const targetId =
    (data[0]! << 24) | (data[1]! << 16) | (data[2]! << 8) | data[3]!;

  // version: length-prefixed string
  const versionLen = data[4]!;
  if (5 + versionLen > data.length) {
    throw new HWError(
      HWErrorCode.APDU_INVALID_RESPONSE,
      'GET_VERSION: version field overflows response',
    );
  }
  const version = decodeDeviceString(
    data.subarray(5, 5 + versionLen),
    'GET_VERSION version',
  );

  // flags: 4 bytes after version
  const flagsOffset = 5 + versionLen;
  let flags = 0;
  if (flagsOffset + 4 <= data.length) {
    flags =
      (data[flagsOffset]! << 24) |
      (data[flagsOffset + 1]! << 16) |
      (data[flagsOffset + 2]! << 8) |
      data[flagsOffset + 3]!;
  }

  // mcuVersion: length-prefixed string after flags
  const mcuOffset = flagsOffset + 4;
  let mcuVersion = '';
  if (mcuOffset < data.length) {
    const mcuLen = data[mcuOffset]!;
    if (mcuOffset + 1 + mcuLen <= data.length) {
      mcuVersion = decodeDeviceString(
        data.subarray(mcuOffset + 1, mcuOffset + 1 + mcuLen),
        'GET_VERSION mcuVersion',
      );
    }
  }

  return { targetId, version, flags, mcuVersion };
}

/**
 * Get the currently open app name and version.
 * Returns null if the dashboard is active (no app open).
 */
export async function getActiveApp(transport: HWTransport): Promise<ActiveAppInfo | null> {
  const response = await transport.send(buildGetAppAndVersion());
  validateApduResponse(response);

  const data = response.data;
  if (data.length < 2) {
    return null; // Dashboard active, no app
  }

  // format: 1B (always 0x01)
  // nameLen: 1B
  // name: nameLen bytes
  // versionLen: 1B
  // version: versionLen bytes
  let offset = 1; // Skip format byte

  const nameLen = data[offset]!;
  offset += 1;
  if (offset + nameLen > data.length) {
    throw new HWError(
      HWErrorCode.APDU_INVALID_RESPONSE,
      'GET_APP_AND_VERSION: name overflows response',
    );
  }
  const name = decodeDeviceString(
    data.subarray(offset, offset + nameLen),
    'GET_APP_AND_VERSION name',
  );
  offset += nameLen;

  if (name === '' || name === 'BOLOS') {
    return null; // Dashboard is active
  }

  let version = '';
  if (offset < data.length) {
    const versionLen = data[offset]!;
    offset += 1;
    if (offset + versionLen <= data.length) {
      version = decodeDeviceString(
        data.subarray(offset, offset + versionLen),
        'GET_APP_AND_VERSION version',
      );
    }
  }

  return { name, version };
}

/**
 * List all installed applications on the device.
 *
 * This is a paginated command — we keep calling until we've
 * received all apps.
 */
export async function listInstalledApps(transport: HWTransport): Promise<AppInfo[]> {
  const apps: AppInfo[] = [];
  let continued = false;

  for (;;) {
    const response = await transport.send(buildListApps(continued));

    // Some firmware returns 0x6e00 (CLA not supported) when no more data
    if (response.statusWord !== StatusWord.SUCCESS) {
      break;
    }

    const parsed = parseAppListResponse(response.data);
    if (parsed.length === 0) {
      break;
    }

    apps.push(...parsed);
    continued = true;
  }

  return apps;
}

/**
 * Open an application by name.
 *
 * After calling this, the device switches to the app context.
 * Dashboard commands will no longer work until the app is closed.
 */
export async function openApp(transport: HWTransport, appName: string): Promise<void> {
  if (appName.length === 0) {
    throw new HWError(HWErrorCode.APP_OPEN_FAILED, 'App name must not be empty');
  }

  const response = await transport.send(buildOpenApp(appName));

  if (response.statusWord === StatusWord.USER_REJECTED) {
    throw new HWError(
      HWErrorCode.APP_OPEN_FAILED,
      `User rejected opening app "${appName}" on device`,
    );
  }

  if (response.statusWord === StatusWord.APP_NOT_FOUND) {
    throw new HWError(
      HWErrorCode.APP_NOT_INSTALLED,
      `App "${appName}" is not installed on the device.`,
    );
  }

  if (response.statusWord !== StatusWord.SUCCESS) {
    throw new HWError(
      HWErrorCode.APP_OPEN_FAILED,
      `Failed to open app "${appName}" (SW: 0x${response.statusWord.toString(16)})`,
    );
  }
}

/**
 * Close the currently running application, returning to dashboard.
 */
export async function closeApp(transport: HWTransport): Promise<void> {
  const response = await transport.send(buildCloseApp());
  // Closing might fail if dashboard already active — that's fine
  if (
    response.statusWord !== StatusWord.SUCCESS &&
    response.statusWord !== StatusWord.CLA_NOT_SUPPORTED
  ) {
    throw new HWError(
      HWErrorCode.APP_OPEN_FAILED,
      `Failed to close app (SW: 0x${response.statusWord.toString(16)})`,
    );
  }
}

/**
 * Compare two semver version strings.
 * Returns true if `actual` >= `required`.
 * Only compares major.minor.patch — no pre-release handling.
 */
export function isVersionSatisfied(actual: string, required: string): boolean {
  const parse = (v: string): readonly [number, number, number] => {
    const parts = v.split('.').map(Number);
    return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0] as const;
  };

  const [aMaj, aMin, aPat] = parse(actual);
  const [rMaj, rMin, rPat] = parse(required);

  if (aMaj !== rMaj) return aMaj > rMaj;
  if (aMin !== rMin) return aMin > rMin;
  return aPat >= rPat;
}

// ─── Internal parsers ─────────────────────────────────────────────────────────

/**
 * Maximum byte length accepted for a device-supplied metadata string
 * (firmware/app version, active-app name). Real Ledger values are a handful of
 * ASCII bytes; this cap sits far above any legitimate value while rejecting a
 * corrupted or hostile device that pads the field toward the 255-byte maximum
 * a single-byte length prefix allows.
 */
const MAX_DEVICE_STRING_BYTES = 64;

/**
 * Decode a device-supplied metadata string.
 *
 * The device is not fully trusted — these bytes come straight off the wire.
 * A default TextDecoder silently substitutes U+FFFD for malformed UTF-8, which
 * would mask a corrupt or spoofed response; instead we decode fatally and cap
 * the length, surfacing anything unexpected as an invalid APDU response.
 */
function decodeDeviceString(bytes: Uint8Array, field: string): string {
  if (bytes.length > MAX_DEVICE_STRING_BYTES) {
    throw new HWError(
      HWErrorCode.APDU_INVALID_RESPONSE,
      `${field} exceeds ${String(MAX_DEVICE_STRING_BYTES)} bytes (${String(bytes.length)})`,
    );
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new HWError(
      HWErrorCode.APDU_INVALID_RESPONSE,
      `${field} is not valid UTF-8`,
    );
  }
}

/**
 * Parse a LIST_APPS response payload.
 *
 * BOLOS SDK 2.x format (Nano S Plus / Stax / Flex):
 *   formatVersion(1) — skip
 *   Per entry:
 *     entryLength(1) sizeInBlocks(2,BE) flags(2) codeHash(32) fullHash(32) nameLen(1) name(N)
 */
function parseAppListResponse(data: Uint8Array): AppInfo[] {
  const apps: AppInfo[] = [];
  let offset = 0;

  // Skip format-version byte
  if (data.length < 1) return apps;
  offset += 1;

  // Parse entries by reading fields sequentially — the entryLength field
  // is informational only. The Ledger DMK ignores it for offset control.
  while (offset + 69 <= data.length) {
    offset += 1; // skip entryLength

    const codeLength = (data[offset]! << 8) | data[offset + 1]!; // sizeInBlocks (2B)
    offset += 2;
    offset += 2; // skip flags

    const hashBytes = data.subarray(offset + 32, offset + 64); // fullHash
    const hash = Array.from(hashBytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    offset += 64; // skip codeHash(32) + fullHash(32)

    if (offset >= data.length) break;
    const nameLen = data[offset]!;
    offset += 1;
    if (offset + nameLen > data.length) break;

    // BOLOS names are null-terminated — strip trailing nulls
    const name = new TextDecoder().decode(data.subarray(offset, offset + nameLen)).replace(/\0+$/g, '');
    offset += nameLen;

    apps.push({ name, version: '', hash, codeLength });
  }

  return apps;
}
