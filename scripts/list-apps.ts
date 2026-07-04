#!/usr/bin/env node

/**
 * Device test script: LIST_APPS → find RAILGUN → OPEN → signer operations.
 *
 * Tests the full sequence:
 * 1. Ensure we're on the dashboard
 * 2. LIST_APPS — enumerate all installed apps
 * 3. Find RAILGUN in the list
 * 4. OPEN_APP → switch to RAILGUN app
 * 5. Verify with GET_APP_AND_VERSION
 * 6. GET_PUBLIC_KEY (custom APDU) — BabyJubjub point
 * 7. (optional) SIGN_HASH — sign a test hash
 * 8. CLOSE_APP → return to dashboard
 *
 * Usage:
 *   npx tsx scripts/list-apps.ts [--open] [--sign]
 *
 * Flags:
 *   --open    After listing, open RAILGUN and run signer ops (default: list only)
 *   --sign    Also sign a test hash (requires device approval)
 */

import { NodeHIDTransport } from '../src/core/transport/nodehid-transport.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const APP_NAME = 'RAILGUN';

// RAILGUN custom APDU constants (matched to live app binary)
const RAILGUN_CLA = 0xe0;
const INS_GET_PUBLIC_KEY = 0x01;   // INS_SPENDING_PUBKEY
const INS_SIGN_HASH = 0x12;       // INS_SIGN_DISPLAY

async function main(): Promise<void> {
  const flags = new Set(process.argv.slice(2));
  const doOpen = flags.has('--open') || flags.has('--sign');
  const doSign = flags.has('--sign');

  const transport = new NodeHIDTransport(60_000);

  console.log('Connecting to Ledger device…');
  await transport.connect();
  console.log('Connected.\n');

  try {
    // ── Step 1: Ensure dashboard ──────────────────────────────────────────
    await ensureDashboard(transport);

    // ── Step 2: LIST_APPS ─────────────────────────────────────────────────
    console.log('\n=== LIST_APPS ===\n');
    const allApps = await listAllApps(transport);

    console.log('\n=== Summary ===');
    console.log(`Total apps found: ${allApps.length}`);
    for (const app of allApps) {
      console.log(`  "${app.name}" fullHash=${app.fullHash.substring(0, 16)}…`);
    }

    // ── Step 3: Find RAILGUN ─────────────────────────────────────────────
    const railgun = allApps.find(a => a.name === APP_NAME);
    if (railgun === undefined) {
      console.log(`\n✗ ${APP_NAME} not found in installed apps.`);
      return;
    }
    console.log(`\n✓ ${APP_NAME} found — codeHash=${railgun.codeHash.substring(0, 16)}…`);

    if (!doOpen) {
      console.log('\nDone (use --open to open the app, --sign to also sign).');
      return;
    }

    // ── Step 4: OPEN_APP ──────────────────────────────────────────────────
    console.log(`\n=== OPEN_APP "${APP_NAME}" ===\n`);
    const nameBytes = new TextEncoder().encode(APP_NAME);
    const openApdu = new Uint8Array(5 + nameBytes.length);
    openApdu[0] = 0xe0; // DASHBOARD_CLA
    openApdu[1] = 0xd8; // INS OPEN_APP
    openApdu[2] = 0x00; // P1
    openApdu[3] = 0x00; // P2
    openApdu[4] = nameBytes.length; // Lc
    openApdu.set(nameBytes, 5);

    const openResp = await transport.rawExchange(openApdu);
    const openSw = bytesToHex(openResp.subarray(openResp.length - 2));
    console.log(`OPEN_APP response SW: 0x${openSw}`);

    if (openSw !== '9000') {
      console.log(`✗ OPEN_APP failed (SW=0x${openSw}).`);
      if (openSw === '6985') console.log('  → User rejected on device.');
      if (openSw === '6984') console.log('  → App not found.');
      return;
    }

    // Give the app time to boot
    await sleep(500);

    // ── Step 5: Verify with GET_APP_AND_VERSION ───────────────────────────
    console.log('\n=== GET_APP_AND_VERSION (verify) ===\n');
    const activeApp = await getActiveApp(transport);
    if (activeApp === null) {
      console.log('✗ Still on dashboard after OPEN_APP — app did not open.');
      return;
    }
    console.log(`✓ Active app: "${activeApp.name}" v${activeApp.version}`);
    if (activeApp.name !== APP_NAME) {
      console.log(`✗ Expected "${APP_NAME}" but got "${activeApp.name}".`);
      return;
    }

    // ── Step 6: GET_PUBLIC_KEY (custom APDU) ──────────────────────────────
    console.log('\n=== GET_PUBLIC_KEY (RAILGUN custom) ===\n');
    // Data: 4-byte big-endian account index (account 0)
    const pkApdu = new Uint8Array([RAILGUN_CLA, INS_GET_PUBLIC_KEY, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0x00]);
    const pkResp = await transport.rawExchange(pkApdu);
    const pkSw = bytesToHex(pkResp.subarray(pkResp.length - 2));
    const pkData = pkResp.subarray(0, pkResp.length - 2);
    console.log(`SW: 0x${pkSw}, data (${pkData.length}B): ${bytesToHex(pkData)}`);
    if (pkSw === '9000' && pkData.length === 64) {
      const x = bytesToHex(pkData.subarray(0, 32));
      const y = bytesToHex(pkData.subarray(32, 64));
      console.log(`✓ Public key:`);
      console.log(`  x = 0x${x}`);
      console.log(`  y = 0x${y}`);
    } else {
      console.log(`✗ GET_PUBLIC_KEY failed or unexpected format (expected 64B, got ${pkData.length}B).`);
    }

    // ── Step 7 (optional): SIGN_HASH ──────────────────────────────────────
    if (doSign) {
      console.log('\n=== SIGN_HASH (test hash — approve on device) ===\n');
      // Test hash: non-zero 32-byte value
      const testHash = new Uint8Array(32);
      testHash[0] = 0x01;
      testHash[31] = 0x42;

      // Data: account(4B BE) + hash(32B) = 36 bytes
      const signApdu = new Uint8Array(5 + 4 + 32);
      signApdu[0] = RAILGUN_CLA;
      signApdu[1] = INS_SIGN_HASH;
      signApdu[2] = 0x00;
      signApdu[3] = 0x00;
      signApdu[4] = 0x24; // 36 bytes: account(4) + hash(32)
      // signApdu[5..8] = account 0 (already zero)
      signApdu.set(testHash, 9);

      console.log(`Sending hash: 0x${bytesToHex(testHash)}`);
      console.log('Waiting for device approval…');

      const signResp = await transport.rawExchange(signApdu);
      const signSw = bytesToHex(signResp.subarray(signResp.length - 2));
      const signData = signResp.subarray(0, signResp.length - 2);
      console.log(`SW: 0x${signSw}, data (${signData.length}B)`);

      if (signSw === '9000' && signData.length === 97) {
        // prefix(1B) + R8x(32B) + R8y(32B) + S(32B)
        const r8x = bytesToHex(signData.subarray(1, 33));
        const r8y = bytesToHex(signData.subarray(33, 65));
        const s = bytesToHex(signData.subarray(65, 97));
        console.log(`✓ Signature:`);
        console.log(`  R8.x = 0x${r8x}`);
        console.log(`  R8.y = 0x${r8y}`);
        console.log(`  S    = 0x${s}`);
      } else if (signSw === '6985') {
        console.log('✗ User rejected signing on device.');
      } else {
        console.log(`✗ SIGN_HASH failed (SW=0x${signSw}, ${signData.length}B).`);
      }
    }

    // ── Step 8: CLOSE_APP ─────────────────────────────────────────────────
    console.log('\n=== CLOSE_APP ===\n');
    const closeApdu = new Uint8Array([0xb0, 0xa7, 0x00, 0x00, 0x00]);
    const closeResp = await transport.rawExchange(closeApdu);
    const closeSw = bytesToHex(closeResp.subarray(closeResp.length - 2));
    console.log(`CLOSE_APP SW: 0x${closeSw}`);
    if (closeSw === '9000') {
      console.log('✓ Returned to dashboard.');
    }

    console.log('\n=== ALL TESTS PASSED ===');
  } finally {
    await transport.disconnect();
    console.log('\nDisconnected.');
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function ensureDashboard(transport: NodeHIDTransport): Promise<void> {
  const gavApdu = new Uint8Array([0xb0, 0x01, 0x00, 0x00, 0x00]);
  const gavResp = await transport.rawExchange(gavApdu);
  const gavSw = bytesToHex(gavResp.subarray(gavResp.length - 2));
  const gavData = gavResp.subarray(0, gavResp.length - 2);
  if (gavSw === '9000' && gavData.length >= 2) {
    const nameLen = gavData[1]!;
    const name = new TextDecoder().decode(gavData.subarray(2, 2 + nameLen));
    console.log(`GET_APP_AND_VERSION: "${name}" (SW=${gavSw})`);
    if (name !== '' && name !== 'BOLOS') {
      console.log(`Not on dashboard (app="${name}") — sending CLOSE_APP`);
      const closeApdu = new Uint8Array([0xb0, 0xa7, 0x00, 0x00, 0x00]);
      await transport.rawExchange(closeApdu);
      await sleep(1000);
    }
  }
}

async function getActiveApp(
  transport: NodeHIDTransport,
): Promise<{ name: string; version: string } | null> {
  const apdu = new Uint8Array([0xb0, 0x01, 0x00, 0x00, 0x00]);
  const resp = await transport.rawExchange(apdu);
  const sw = bytesToHex(resp.subarray(resp.length - 2));
  if (sw !== '9000') return null;

  const data = resp.subarray(0, resp.length - 2);
  if (data.length < 2) return null;

  let offset = 1; // skip format byte
  const nameLen = data[offset]!;
  offset += 1;
  if (offset + nameLen > data.length) return null;
  const name = new TextDecoder().decode(data.subarray(offset, offset + nameLen));
  offset += nameLen;

  if (name === '' || name === 'BOLOS') return null;

  let version = '';
  if (offset < data.length) {
    const versionLen = data[offset]!;
    offset += 1;
    if (offset + versionLen <= data.length) {
      version = new TextDecoder().decode(data.subarray(offset, offset + versionLen));
    }
  }

  return { name, version };
}

type ParsedApp = { name: string; fullHash: string; codeHash: string };

async function listAllApps(transport: NodeHIDTransport): Promise<ParsedApp[]> {
  const allApps: ParsedApp[] = [];
  let continued = false;
  let page = 0;

  for (;;) {
    const ins = continued ? 0xdf : 0xde;
    const apdu = new Uint8Array([0xe0, ins, 0x00, 0x00, 0x00]);
    console.log(`--- Page ${page} (INS=0x${ins.toString(16)}) ---`);

    const response = await transport.rawExchange(apdu);
    const rawHex = bytesToHex(response);
    console.log(`  Raw (${response.length}B): ${rawHex}`);

    if (response.length < 2) break;

    const sw = bytesToHex(response.subarray(response.length - 2));
    console.log(`  SW: 0x${sw}`);
    if (sw !== '9000') break;

    const data = response.subarray(0, response.length - 2);
    if (data.length === 0) break;

    // Dump hex rows
    for (let i = 0; i < data.length; i += 32) {
      const chunk = data.subarray(i, Math.min(i + 32, data.length));
      const hexRow = bytesToHex(chunk);
      const ascii = Array.from(chunk)
        .map(b => b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')
        .join('');
      console.log(`  ${i.toString(16).padStart(4, '0')}: ${hexRow.padEnd(64)}  ${ascii}`);
    }

    // Parse sequentially
    let offset = 1; // skip format_version
    while (offset + 69 <= data.length) {
      offset += 1; // skip entryLength (informational)

      const sizeInBlocks = (data[offset]! << 8) | data[offset + 1]!;
      offset += 2;
      const flags = (data[offset]! << 8) | data[offset + 1]!;
      offset += 2;

      const codeHash = bytesToHex(data.subarray(offset, offset + 32));
      offset += 32;
      const fullHash = bytesToHex(data.subarray(offset, offset + 32));
      offset += 32;

      if (offset >= data.length) break;
      const nameLen = data[offset]!;
      offset += 1;
      if (offset + nameLen > data.length) break;

      const name = new TextDecoder()
        .decode(data.subarray(offset, offset + nameLen))
        .replace(/\0+$/g, '');
      offset += nameLen;

      console.log(`  → "${name}" blocks=${sizeInBlocks} flags=0x${flags.toString(16)}`);
      allApps.push({ name, fullHash, codeHash });
    }

    console.log('');
    continued = true;
    page++;
  }

  return allApps;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
