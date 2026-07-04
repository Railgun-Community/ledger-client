/**
 * EIP-7702 blind signing test.
 *
 * Tests whether the Ledger Ethereum app allows INS=0x34 (SIGN EIP 7702 AUTHORIZATION)
 * with an arbitrary (non-whitelisted) delegate address.
 *
 * Prerequisites:
 * - Ledger device connected via USB
 * - Ethereum app open on the device
 * - "Blind signing" enabled in app settings (Settings → Blind signing)
 *
 * Usage:
 *   npx tsx scripts/test-7702-blind.ts [--address 0x...]
 */

import { NodeHIDTransport } from '../src/core/transport/nodehid-transport.js';

// ─── Config ──────────────────────────────────────────────────────────────────

/** Default test address — a random address NOT in Ledger's CAL whitelist. */
const DEFAULT_TEST_ADDRESS = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

/** Known whitelisted address (Simple7702Account) — from firmware whitelist_7702.c */
const WHITELISTED_ADDRESS = '0x4Cd241E8d1510e30b20763 97afC7508Ae59C66c9'.replace(/\s/g, '');

const DERIVATION_PATH = "44'/60'/0'/0/0";
const CHAIN_ID = 1n; // Ethereum mainnet
const NONCE = 0n;

// ─── APDU helpers ────────────────────────────────────────────────────────────

const HARDENED = 0x80000000;

function parseBip32Path(path: string): number[] {
  return path.split('/').map((component) => {
    const hardened = component.endsWith("'");
    const index = parseInt(hardened ? component.slice(0, -1) : component, 10);
    return hardened ? (index | HARDENED) >>> 0 : index;
  });
}

function bigintToUint64BE(value: bigint): Uint8Array {
  const buf = new Uint8Array(8);
  const view = new DataView(buf.buffer);
  view.setBigUint64(0, value, false);
  return buf;
}

function writeTlv(tag: number, value: Uint8Array): Uint8Array {
  const entry = new Uint8Array(1 + 1 + value.length);
  entry[0] = tag;
  entry[1] = value.length;
  entry.set(value, 2);
  return entry;
}

function parseHexAddress(address: string): Uint8Array {
  const hex = address.startsWith('0x') ? address.slice(2) : address;
  const bytes = new Uint8Array(20);
  for (let i = 0; i < 20; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function buildAuth7702Apdu(address: string, chainId: bigint, nonce: bigint): Uint8Array {
  const pathIndices = parseBip32Path(DERIVATION_PATH);
  const addressBytes = parseHexAddress(address);

  // Build TLV
  const version = writeTlv(0x00, new Uint8Array([0x01]));
  const addr = writeTlv(0x01, addressBytes);
  const chain = writeTlv(0x02, bigintToUint64BE(chainId));
  const nonceTlv = writeTlv(0x03, bigintToUint64BE(nonce));
  const tlvLen = version.length + addr.length + chain.length + nonceTlv.length;
  const tlv = new Uint8Array(tlvLen);
  let tlvOffset = 0;
  tlv.set(version, tlvOffset); tlvOffset += version.length;
  tlv.set(addr, tlvOffset); tlvOffset += addr.length;
  tlv.set(chain, tlvOffset); tlvOffset += chain.length;
  tlv.set(nonceTlv, tlvOffset);

  // Build APDU data: path + struct size + TLV
  const pathLen = 1 + pathIndices.length * 4;
  const structSizeLen = 2;
  const data = new Uint8Array(pathLen + structSizeLen + tlv.length);
  const view = new DataView(data.buffer);
  let offset = 0;

  data[offset++] = pathIndices.length;
  for (const idx of pathIndices) {
    view.setUint32(offset, idx, false);
    offset += 4;
  }
  view.setUint16(offset, tlv.length, false);
  offset += 2;
  data.set(tlv, offset);

  // Full APDU: CLA=0xE0, INS=0x34, P1=0x01, P2=0x00
  const apdu = new Uint8Array(5 + data.length);
  apdu[0] = 0xe0;
  apdu[1] = 0x34;
  apdu[2] = 0x01;
  apdu[3] = 0x00;
  apdu[4] = data.length;
  apdu.set(data, 5);

  return apdu;
}

function bufToHex(buf: Uint8Array): string {
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const testAddress = process.argv.find((a) => a.startsWith('0x')) ?? DEFAULT_TEST_ADDRESS;

  console.log('=== EIP-7702 Blind Signing Test ===\n');
  console.log(`Test address (non-whitelisted): ${testAddress}`);
  console.log(`Control address (whitelisted):  ${WHITELISTED_ADDRESS}`);
  console.log(`Derivation path: ${DERIVATION_PATH}`);
  console.log(`Chain ID: ${CHAIN_ID}, Nonce: ${NONCE}\n`);

  const transport = new NodeHIDTransport(60_000);
  await transport.connect();
  console.log('✓ Connected to device\n');

  try {
    // Step 1: GET APP CONFIGURATION
    console.log('--- Step 1: GET APP CONFIGURATION ---');
    const configApdu = new Uint8Array([0xe0, 0x06, 0x00, 0x00, 0x00]);
    const configResp = await transport.rawExchange(configApdu);
    const sw = (configResp[configResp.length - 2]! << 8) | configResp[configResp.length - 1]!;

    if (sw !== 0x9000) {
      console.log(`✗ GET APP CONFIGURATION failed: 0x${sw.toString(16)}`);
      console.log('  Is the Ethereum app open on the device?');
      return;
    }

    const flags = configResp[0]!;
    const appVersion = `${configResp[1]}.${configResp[2]}.${configResp[3]}`;
    const blindSignEnabled = (flags & 0x01) !== 0;

    console.log(`  App version: ${appVersion}`);
    console.log(`  Flags: 0x${flags.toString(16).padStart(2, '0')}`);
    console.log(`  Blind signing enabled: ${blindSignEnabled}`);
    console.log(`  ERC20 external info: ${(flags & 0x02) !== 0}`);
    console.log(`  TX check enabled: ${(flags & 0x10) !== 0}`);
    console.log();

    if (!blindSignEnabled) {
      console.log('⚠ Blind signing is DISABLED.');
      console.log('  Enable it: Ethereum app → Settings → Blind signing → Enabled');
      console.log('  Proceeding anyway to capture the error code...\n');
    }

    console.log('  NOTE: Firmware also has an eip7702_enable storage flag.');
    console.log('  If 7702 is not enabled in device settings, the device rejects with SWO_COMMAND_NOT_ALLOWED.');
    console.log('  Check: Ethereum app → Settings → look for "EIP-7702" or "7702" toggle.\n');

    // Step 2: Control test — sign with whitelisted address
    console.log('--- Step 2: Control — Whitelisted address ---');
    console.log('  ⏳ Sending INS=0x34 with whitelisted address...');
    console.log('  ▶ CHECK DEVICE — Approve the delegation on the Ledger screen');
    const controlApdu = buildAuth7702Apdu(WHITELISTED_ADDRESS, CHAIN_ID, NONCE);
    const controlResp = await transport.rawExchange(controlApdu);
    const controlSw = (controlResp[controlResp.length - 2]! << 8) | controlResp[controlResp.length - 1]!;

    if (controlSw === 0x9000) {
      const parity = controlResp[0];
      const r = bufToHex(controlResp.slice(1, 33));
      console.log(`  ✓ Whitelisted signing succeeded: yParity=${parity}, r=0x${r.slice(0, 8)}...`);
    } else if (controlSw === 0x6982) {
      console.log(`  ✗ User rejected on device (0x6982) — that's expected if you declined`);
    } else {
      console.log(`  ✗ Control failed: 0x${controlSw.toString(16)}`);
    }
    console.log();

    // Step 3: Test — sign with non-whitelisted address
    console.log('--- Step 3: Test — Non-whitelisted address ---');
    console.log(`  ⏳ Sending INS=0x34 with ${testAddress}...`);
    console.log('  ▶ CHECK DEVICE — If a prompt appears, approve. If not, the device rejected automatically.');
    const testApdu = buildAuth7702Apdu(testAddress, CHAIN_ID, NONCE);
    const testResp = await transport.rawExchange(testApdu);
    const testSw = (testResp[testResp.length - 2]! << 8) | testResp[testResp.length - 1]!;

    console.log();
    if (testSw === 0x9000) {
      const parity = testResp[0];
      const r = bufToHex(testResp.slice(1, 33));
      const s = bufToHex(testResp.slice(33, 65));
      console.log('  🎉 NON-WHITELISTED SIGNING SUCCEEDED!');
      console.log(`     yParity=${parity}, r=0x${r.slice(0, 8)}..., s=0x${s.slice(0, 8)}...`);
      console.log('\n  ✓ Blind signing WORKS for EIP-7702 with arbitrary addresses.');
      console.log('  → No custom app or provide flow needed.');
    } else if (testSw === 0x6982) {
      console.log('  ✓ Device showed prompt but user rejected (0x6982).');
      console.log('  → Blind signing WORKS — device prompted for review.');
      console.log('  → Re-run and approve on device to confirm full flow.');
    } else {
      console.log(`  ✗ Device rejected: 0x${testSw.toString(16)}`);
      console.log();

      // Interpret known status words
      const swMap: Record<number, string> = {
        0x6980: 'Unknown delegate — address not in firmware whitelist (whitelist_7702.c)',
        0x6985: 'Command not allowed — EIP-7702 not enabled in device settings OR delegate not whitelisted',
        0x6a80: 'Invalid data',
        0x6501: 'Transaction type not supported',
        0x6b00: 'Incorrect P1/P2',
        0x6d00: 'Incorrect INS — firmware may not support EIP-7702',
      };
      const hint = swMap[testSw];
      if (hint) {
        console.log(`  Hint: ${hint}`);
      }

      console.log('\n  → Blind signing does NOT work for non-whitelisted addresses.');
      console.log('  → Need alternative approach (PROVIDE PROXY INFO or PROVIDE TRUSTED NAME).');
    }

    // Step 4: Raw hex dump for debugging
    console.log('\n--- Raw responses ---');
    console.log(`  Control: ${bufToHex(controlResp)} (SW=0x${controlSw.toString(16)})`);
    console.log(`  Test:    ${bufToHex(testResp)} (SW=0x${testSw.toString(16)})`);

  } finally {
    await transport.disconnect();
    console.log('\n✓ Disconnected');
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
