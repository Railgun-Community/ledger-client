/**
 * Tests for DeviceManager functions.
 *
 * Uses MockTransport with pre-programmed APDU responses to test parsing
 * of device info, app lists, active app, open/close operations.
 */

import { describe, it, expect } from 'vitest';
import { MockTransport } from '../integration/mock-transport.js';
import {
  getDeviceInfo,
  getActiveApp,
  listInstalledApps,
  openApp,
  closeApp,
  isVersionSatisfied,
} from '../../src/core/device/device-manager.js';
import { StatusWord } from '../../src/core/transport/types.js';
import { HWError, HWErrorCode } from '../../src/core/errors.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function successResponse(data: Uint8Array) {
  return { data, statusWord: StatusWord.SUCCESS };
}

function errorResponse(sw: number) {
  return { data: new Uint8Array(0), statusWord: sw };
}

/**
 * Build a synthetic GET_VERSION response.
 * Format: targetId(4B) + versionLen(1B) + version + flags(4B) + mcuLen(1B) + mcu
 */
function buildVersionResponse(
  targetId: number,
  version: string,
  flags: number,
  mcuVersion: string,
): Uint8Array {
  const versionBytes = new TextEncoder().encode(version);
  const mcuBytes = new TextEncoder().encode(mcuVersion);
  const buf = new Uint8Array(4 + 1 + versionBytes.length + 4 + 1 + mcuBytes.length);
  let offset = 0;

  // targetId (4B big-endian)
  buf[offset++] = (targetId >>> 24) & 0xff;
  buf[offset++] = (targetId >>> 16) & 0xff;
  buf[offset++] = (targetId >>> 8) & 0xff;
  buf[offset++] = targetId & 0xff;

  // version
  buf[offset++] = versionBytes.length;
  buf.set(versionBytes, offset);
  offset += versionBytes.length;

  // flags (4B big-endian)
  buf[offset++] = (flags >>> 24) & 0xff;
  buf[offset++] = (flags >>> 16) & 0xff;
  buf[offset++] = (flags >>> 8) & 0xff;
  buf[offset++] = flags & 0xff;

  // mcuVersion
  buf[offset++] = mcuBytes.length;
  buf.set(mcuBytes, offset);

  return buf;
}

/**
 * Build a synthetic GET_APP_AND_VERSION response.
 * Format: format(1B) + nameLen(1B) + name + versionLen(1B) + version
 */
function buildAppVersionResponse(name: string, version: string): Uint8Array {
  const nameBytes = new TextEncoder().encode(name);
  const versionBytes = new TextEncoder().encode(version);
  const buf = new Uint8Array(1 + 1 + nameBytes.length + 1 + versionBytes.length);
  let offset = 0;

  buf[offset++] = 0x01; // format
  buf[offset++] = nameBytes.length;
  buf.set(nameBytes, offset);
  offset += nameBytes.length;
  buf[offset++] = versionBytes.length;
  buf.set(versionBytes, offset);

  return buf;
}

/**
 * Build a synthetic LIST_APPS response with one app entry.
 * BOLOS SDK 2.x format:
 *   entryLength(1B) + sizeInBlocks(2B,BE) + flags(2B) + codeHash(32B) + fullHash(32B) + nameLen(1B) + name
 *
 * NOTE: Does NOT include the format-version prefix byte — caller wraps entries
 *       with buildAppListPage() which prepends 0x01.
 */
function buildAppListEntry(
  name: string,
  hash: Uint8Array,
  codeLength: number,
): Uint8Array {
  const nameBytes = new TextEncoder().encode(name);
  const entryLen = 2 + 2 + 32 + 32 + 1 + nameBytes.length;
  const buf = new Uint8Array(1 + entryLen);
  let offset = 0;

  buf[offset++] = entryLen; // entry length

  // sizeInBlocks (2B big-endian)
  buf[offset++] = (codeLength >>> 8) & 0xff;
  buf[offset++] = codeLength & 0xff;

  // flags (2B) — zeroed
  buf[offset++] = 0x00;
  buf[offset++] = 0x00;

  // codeHash (32B)
  buf.set(hash.subarray(0, 32), offset);
  offset += 32;

  // fullHash (32B) — use same hash for testing
  buf.set(hash.subarray(0, 32), offset);
  offset += 32;

  // name (LV)
  buf[offset++] = nameBytes.length;
  buf.set(nameBytes, offset);

  return buf;
}

/** Wrap one or more entries in a LIST_APPS page with the format-version prefix. */
function buildAppListPage(...entries: Uint8Array[]): Uint8Array {
  let totalLen = 1; // format-version byte
  for (const e of entries) totalLen += e.length;
  const buf = new Uint8Array(totalLen);
  buf[0] = 0x01; // format version
  let offset = 1;
  for (const e of entries) {
    buf.set(e, offset);
    offset += e.length;
  }
  return buf;
}

/**
 * Build a GET_VERSION response with raw version bytes (may be invalid UTF-8 or
 * over-length). mcuLen is set to 0 so the mcuVersion field decodes to ''.
 */
function buildVersionResponseRawVersion(versionBytes: Uint8Array): Uint8Array {
  const buf = new Uint8Array(4 + 1 + versionBytes.length + 4 + 1);
  buf[4] = versionBytes.length;
  buf.set(versionBytes, 5);
  // flags (4B) left zeroed; trailing mcuLen byte left 0 → empty mcuVersion
  return buf;
}

/**
 * Build a GET_APP_AND_VERSION response with raw name/version bytes.
 */
function buildAppVersionResponseRaw(
  nameBytes: Uint8Array,
  versionBytes: Uint8Array,
): Uint8Array {
  const buf = new Uint8Array(1 + 1 + nameBytes.length + 1 + versionBytes.length);
  let offset = 0;
  buf[offset++] = 0x01; // format
  buf[offset++] = nameBytes.length;
  buf.set(nameBytes, offset);
  offset += nameBytes.length;
  buf[offset++] = versionBytes.length;
  buf.set(versionBytes, offset);
  return buf;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('getDeviceInfo', () => {
  it('parses a valid GET_VERSION response', async () => {
    const transport = new MockTransport();
    await transport.connect();

    const response = buildVersionResponse(0x33000004, '2.1.0', 0x00000000, '1.12');
    transport.enqueueResponse(successResponse(response));

    const info = await getDeviceInfo(transport);
    expect(info.targetId).toBe(0x33000004);
    expect(info.version).toBe('2.1.0');
    expect(info.flags).toBe(0);
    expect(info.mcuVersion).toBe('1.12');
  });

  it('rejects a response that is too short', async () => {
    const transport = new MockTransport();
    await transport.connect();
    transport.enqueueResponse(successResponse(new Uint8Array(4)));

    await expect(getDeviceInfo(transport)).rejects.toThrow(HWError);
  });
});

describe('getActiveApp', () => {
  it('returns app info when an app is open', async () => {
    const transport = new MockTransport();
    await transport.connect();

    transport.enqueueResponse(
      successResponse(buildAppVersionResponse('Ethereum', '1.12.1')),
    );

    const app = await getActiveApp(transport);
    expect(app).not.toBeNull();
    expect(app!.name).toBe('Ethereum');
    expect(app!.version).toBe('1.12.1');
  });

  it('returns null when dashboard is active (BOLOS)', async () => {
    const transport = new MockTransport();
    await transport.connect();

    transport.enqueueResponse(
      successResponse(buildAppVersionResponse('BOLOS', '0.0.0')),
    );

    const app = await getActiveApp(transport);
    expect(app).toBeNull();
  });

  it('returns null for empty response', async () => {
    const transport = new MockTransport();
    await transport.connect();
    transport.enqueueResponse(successResponse(new Uint8Array(0)));

    const app = await getActiveApp(transport);
    expect(app).toBeNull();
  });
});

describe('listInstalledApps', () => {
  it('parses a single-page app list', async () => {
    const transport = new MockTransport();
    await transport.connect();

    const hash = new Uint8Array(32).fill(0xab);
    const entry1 = buildAppListEntry('Ethereum', hash, 1024);
    const entry2 = buildAppListEntry('RAILGUN', hash, 2048);

    const page = buildAppListPage(entry1, entry2);

    transport.enqueueResponse(successResponse(page));
    // Second call returns non-success to signal end
    transport.enqueueResponse(errorResponse(StatusWord.CLA_NOT_SUPPORTED));

    const apps = await listInstalledApps(transport);
    expect(apps).toHaveLength(2);
    expect(apps[0]!.name).toBe('Ethereum');
    expect(apps[1]!.name).toBe('RAILGUN');
  });

  it('returns empty array when device has no apps', async () => {
    const transport = new MockTransport();
    await transport.connect();
    transport.enqueueResponse(errorResponse(StatusWord.CLA_NOT_SUPPORTED));

    const apps = await listInstalledApps(transport);
    expect(apps).toHaveLength(0);
  });
});

describe('openApp', () => {
  it('keeps device rejection under APP_OPEN_FAILED at the low-level helper', async () => {
    const transport = new MockTransport();
    await transport.connect();
    transport.enqueueResponse(errorResponse(StatusWord.USER_REJECTED));

    await expect(openApp(transport, 'Ethereum')).rejects.toMatchObject({
      code: HWErrorCode.APP_OPEN_FAILED,
      message: 'User rejected opening app "Ethereum" on device',
    });
  });
});

describe('openApp', () => {
  it('succeeds on SW 0x9000', async () => {
    const transport = new MockTransport();
    await transport.connect();
    transport.enqueueResponse(successResponse(new Uint8Array(0)));

    await expect(openApp(transport, 'RAILGUN')).resolves.toBeUndefined();
    expect(transport.sentCommands).toHaveLength(1);
  });

  it('throws on user rejection', async () => {
    const transport = new MockTransport();
    await transport.connect();
    transport.enqueueResponse(errorResponse(StatusWord.USER_REJECTED));

    await expect(openApp(transport, 'RAILGUN')).rejects.toThrow(HWError);
  });

  it('rejects empty app name', async () => {
    const transport = new MockTransport();
    await transport.connect();

    await expect(openApp(transport, '')).rejects.toThrow(HWError);
  });
});

describe('closeApp', () => {
  it('succeeds on SW 0x9000', async () => {
    const transport = new MockTransport();
    await transport.connect();
    transport.enqueueResponse(successResponse(new Uint8Array(0)));

    await expect(closeApp(transport)).resolves.toBeUndefined();
  });

  it('tolerates CLA_NOT_SUPPORTED (dashboard already active)', async () => {
    const transport = new MockTransport();
    await transport.connect();
    transport.enqueueResponse(errorResponse(StatusWord.CLA_NOT_SUPPORTED));

    await expect(closeApp(transport)).resolves.toBeUndefined();
  });
});

describe('device-string hardening', () => {
  // 0xff is never a valid UTF-8 byte; a default TextDecoder would substitute
  // U+FFFD and hide the corruption. The hardened path must reject it.
  const invalidUtf8 = new Uint8Array([0xff, 0xfe]);

  it('rejects invalid UTF-8 in the firmware version', async () => {
    const transport = new MockTransport();
    await transport.connect();
    transport.enqueueResponse(
      successResponse(buildVersionResponseRawVersion(invalidUtf8)),
    );

    await expect(getDeviceInfo(transport)).rejects.toMatchObject({
      code: HWErrorCode.APDU_INVALID_RESPONSE,
    });
  });

  it('rejects a firmware version longer than the byte cap', async () => {
    const transport = new MockTransport();
    await transport.connect();
    // 65 bytes of valid ASCII — valid UTF-8, but past the 64-byte cap.
    const overLong = new TextEncoder().encode('a'.repeat(65));
    transport.enqueueResponse(
      successResponse(buildVersionResponseRawVersion(overLong)),
    );

    await expect(getDeviceInfo(transport)).rejects.toMatchObject({
      code: HWErrorCode.APDU_INVALID_RESPONSE,
    });
  });

  it('rejects invalid UTF-8 in the active-app name', async () => {
    const transport = new MockTransport();
    await transport.connect();
    transport.enqueueResponse(
      successResponse(
        buildAppVersionResponseRaw(invalidUtf8, new TextEncoder().encode('1.0.0')),
      ),
    );

    await expect(getActiveApp(transport)).rejects.toMatchObject({
      code: HWErrorCode.APDU_INVALID_RESPONSE,
    });
  });

  it('accepts a valid multibyte UTF-8 name (does not over-reject)', async () => {
    const transport = new MockTransport();
    await transport.connect();
    // "café" — the é is a valid 2-byte UTF-8 sequence.
    const nameBytes = new TextEncoder().encode('café');
    transport.enqueueResponse(
      successResponse(
        buildAppVersionResponseRaw(nameBytes, new TextEncoder().encode('1.0.0')),
      ),
    );

    const app = await getActiveApp(transport);
    expect(app).not.toBeNull();
    expect(app!.name).toBe('café');
    expect(app!.version).toBe('1.0.0');
  });
});

describe('isVersionSatisfied', () => {
  it('returns true for exact match', () => {
    expect(isVersionSatisfied('1.12.0', '1.12.0')).toBe(true);
  });

  it('returns true when actual > required (patch)', () => {
    expect(isVersionSatisfied('1.12.1', '1.12.0')).toBe(true);
  });

  it('returns true when actual > required (minor)', () => {
    expect(isVersionSatisfied('1.13.0', '1.12.0')).toBe(true);
  });

  it('returns true when actual > required (major)', () => {
    expect(isVersionSatisfied('2.0.0', '1.12.0')).toBe(true);
  });

  it('returns false when actual < required (patch)', () => {
    expect(isVersionSatisfied('1.11.9', '1.12.0')).toBe(false);
  });

  it('returns false when actual < required (major)', () => {
    expect(isVersionSatisfied('0.99.99', '1.0.0')).toBe(false);
  });

  it('handles missing patch', () => {
    expect(isVersionSatisfied('1.12', '1.12.0')).toBe(true);
  });
});
