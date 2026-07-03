#!/usr/bin/env node

/**
 * RAILGUN live device tests.
 *
 * Exercises every core APDU command against a real Ledger
 * with the RAILGUN app installed. Validates wire format,
 * response parsing, and protocol invariants.
 *
 * Modes:
 *   (default)     getPublicKey (no device approval needed)
 *   --sign        also signs a test hash (device approval required)
 *   --raw         also validates raw APDU wire bytes
 *   --all         enables --sign and --raw
 *
 * Usage:
 *   npx tsx scripts/test-railgun-live.ts
 *   npx tsx scripts/test-railgun-live.ts --sign
 *   npx tsx scripts/test-railgun-live.ts --all
 */

import { NodeHIDTransport } from '../src/core/transport/nodehid-transport.js';
import {
  getDeviceInfo,
  getActiveApp,
  listInstalledApps,
  openApp,
  closeApp,
} from '../src/core/device/device-manager.js';
import { RailgunSigner } from '../src/core/signers/railgun-signer.js';
import {
  RAILGUN_CLA,
  RailgunAppINS,
  encodeAccountIndex,
  buildGetPublicKey,
  buildSignHash,
  SIGN_RESPONSE_LENGTH,
  PUBLIC_KEY_RESPONSE_LENGTH,
} from '../src/core/transport/apdu.js';
import { BABYJUBJUB_FIELD_PRIME, BABYJUBJUB_SUBGROUP_ORDER } from '../src/validation/signature.js';
import { deserializeApduResponse } from '../src/core/transport/apdu-wire.js';

// ─── Config ───────────────────────────────────────────────────────────────────

const APP_NAME = 'RAILGUN';

/**
 * Reference test hash from ledgerhw-signer test suite.
 * The SDK encodes the bigint LE on the wire to match the device's
 * internal byte → field decoding, so no host-side byte reversal is needed.
 */
const TEST_HASH_HEX = '078887e32aedbab3a6dd84a17e57c990cd5e5fd778fb9fba649dc3a6b396382c';

/** Simple small test hash for basic signing. */
const SIMPLE_HASH = 0xabcdabcdn;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hexToBytes(hex: string): Uint8Array {
  const len = hex.length / 2;
  const buf = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    buf[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return buf;
}

function bytesToHex(buf: Uint8Array): string {
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function bigintToHex(n: bigint, padBytes = 32): string {
  return n.toString(16).padStart(padBytes * 2, '0');
}

type TestResult = { name: string; passed: boolean; detail: string };

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

// ─── Test runner ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const flags = new Set(process.argv.slice(2));
  const doAll = flags.has('--all');
  const doSign = doAll || flags.has('--sign');
  const doRaw = doAll || flags.has('--raw');
  const results: TestResult[] = [];

  const transport = new NodeHIDTransport(60_000);

  console.log('╔════════════════════════════════════════════════╗');
  console.log('║   RAILGUN Live Device Tests                   ║');
  console.log('╠════════════════════════════════════════════════╣');
  console.log(`║   --sign: ${doSign ? 'ON' : 'off'}  --raw: ${doRaw ? 'ON' : 'off'}${' '.repeat(26)}║`);
  console.log('╚════════════════════════════════════════════════╝\n');

  console.log('Connecting to Ledger device…');
  await transport.connect();
  console.log('Connected.\n');

  try {
    // ── Ensure dashboard ──────────────────────────────────────────────
    const activeBefore = await getActiveApp(transport);
    if (activeBefore !== null) {
      console.log(`  App "${activeBefore.name}" is open — closing first.`);
      await closeApp(transport);
      await sleep(1000);
    }

    // ── T01: Device info ──────────────────────────────────────────────
    await runTest(results, 'T01 getDeviceInfo', async () => {
      const info = await getDeviceInfo(transport);
      assert(info.version.length > 0, 'empty firmware version');
      assert(info.targetId !== 0, 'zero target ID');
      return `FW ${info.version}, target=0x${info.targetId.toString(16)}`;
    });

    // ── T02: List apps — find RAILGUN ────────────────────────────────
    let hasRailgun = false;
    await runTest(results, 'T02 listInstalledApps', async () => {
      const apps = await listInstalledApps(transport);
      hasRailgun = apps.some((a) => a.name === APP_NAME);
      const names = apps.map((a) => a.name).join(', ');
      assert(hasRailgun, `${APP_NAME} not found in [${names}]`);
      return `${apps.length} app(s): ${names}`;
    });

    if (!hasRailgun) {
      console.log(`\n✗ ${APP_NAME} not installed — remaining tests skipped.\n`);
      printResults(results);
      return;
    }

    // ── T03: Open RAILGUN ────────────────────────────────────────────
    await runTest(results, 'T03 openApp', async () => {
      await openApp(transport, APP_NAME);
      await sleep(500);
      const active = await getActiveApp(transport);
      assert(active !== null, 'no app active after OPEN_APP');
      assert(active!.name === APP_NAME, `expected ${APP_NAME}, got "${active!.name}"`);
      return `${active!.name} v${active!.version}`;
    });

    // ── T04: Get public key (high-level API) ──────────────────────
    const signer = new RailgunSigner({ transport });
    let pubKey: { x: bigint; y: bigint } | null = null;

    await runTest(results, 'T04 getPublicKey', async () => {
      pubKey = await signer.getPublicKey();
      assert(pubKey.x > 0n, 'pubkey x is zero');
      assert(pubKey.y > 0n, 'pubkey y is zero');
      assert(pubKey.x < BABYJUBJUB_FIELD_PRIME, 'pubkey x out of field');
      assert(pubKey.y < BABYJUBJUB_FIELD_PRIME, 'pubkey y out of field');
      return `x=0x${bigintToHex(pubKey.x).substring(0, 16)}… y=0x${bigintToHex(pubKey.y).substring(0, 16)}…`;
    });

    // ── T05: Public key determinism ─────────────────────────────
    await runTest(results, 'T05 pubkey determinism', async () => {
      const pk2 = await signer.getPublicKey();
      assert(pk2.x === pubKey!.x, `x mismatch: ${pk2.x} != ${pubKey!.x}`);
      assert(pk2.y === pubKey!.y, `y mismatch: ${pk2.y} != ${pubKey!.y}`);
      return 'second GET_PUBLIC_KEY matches first';
    });

    // ── Raw APDU tests ────────────────────────────────────────────────
    if (doRaw) {
      // T06: Verify GET_PUBLIC_KEY wire format
      await runTest(results, 'T06 raw GET_PUBKEY wire', async () => {
        const cmd = buildGetPublicKey();
        assert(cmd.cla === 0xe0, `CLA 0x${cmd.cla.toString(16)} != 0xe0`);
        assert(cmd.ins === 0x01, `INS 0x${cmd.ins.toString(16)} != 0x01`);
        assert(cmd.data!.length === 4, `data length ${cmd.data!.length} != 4`);

        const header = new Uint8Array([cmd.cla, cmd.ins, cmd.p1, cmd.p2, cmd.data!.length]);
        const full = new Uint8Array(header.length + cmd.data!.length);
        full.set(header);
        full.set(cmd.data!, header.length);
        const hex = bytesToHex(full);
        // CLA=E0, INS=01, P1=00, P2=00, Lc=04, account=00000000
        const expected = 'e00100000400000000';
        assert(hex === expected, `APDU mismatch: got ${hex}, expected ${expected}`);
        return `wire matches reference: ${hex}`;
      });

      // T07: Verify SIGN_HASH wire format
      await runTest(results, 'T07 raw SIGN_HASH wire', async () => {
        const hash = new Uint8Array(32).fill(0);
        hash[31] = 0x42; // test value
        const cmd = buildSignHash(hash);
        assert(cmd.data!.length === 36, `data length ${cmd.data!.length} != 36`);
        // First 4 bytes: account index 0 in BE
        assert(cmd.data![0] === 0 && cmd.data![1] === 0 && cmd.data![2] === 0 && cmd.data![3] === 0, 'account not at offset 0');
        assert(cmd.data![35] === 0x42, 'hash not at correct offset');

        const header = new Uint8Array([cmd.cla, cmd.ins, cmd.p1, cmd.p2, cmd.data!.length]);
        const prefix = bytesToHex(header);
        // CLA=E0, INS=12, P1=00, P2=00, Lc=24 (36 decimal)
        assert(prefix === 'e012000024', `APDU prefix mismatch: got ${prefix}, expected e012000024`);
        return `wire prefix=e012000024, Lc=36, account(4B)+hash(32B)`;
      });

      // T08: Raw APDU exchange — GET_PUBLIC_KEY
      await runTest(results, 'T08 raw exchange pubkey', async () => {
        // CLA=E0, INS=01, P1=00, P2=00, Lc=04, account=00000000
        const rawApdu = hexToBytes('e00100000400000000');
        const rawResp = await transport.rawExchange(rawApdu);
        assert(rawResp.length >= 66, `response too short: ${rawResp.length} bytes`);

        const resp = deserializeApduResponse(rawResp);
        assert(resp.statusWord === 0x9000, `SW=0x${resp.statusWord.toString(16)}`);
        assert(resp.data.length === 64, `data ${resp.data.length} != 64`);

        // Should match high-level API result
        let x = 0n, y = 0n;
        for (let i = 0; i < 32; i++) x = (x << 8n) | BigInt(resp.data[i]!);
        for (let i = 32; i < 64; i++) y = (y << 8n) | BigInt(resp.data[i]!);
        assert(x === pubKey!.x, 'raw x != high-level x');
        assert(y === pubKey!.y, 'raw y != high-level y');
        return 'raw exchange matches high-level API';
      });
    }

    // ── Signing tests ─────────────────────────────────────────────────
    if (doSign) {
      // T09: Sign a simple hash
      await runTest(results, 'T09 sign (simple)', async () => {
        console.log('    Approve the SIGN request on your Ledger…');
        const sig = await signer.sign(SIMPLE_HASH);

        // Validate field membership
        assert(sig.R8[0] >= 0n && sig.R8[0] < BABYJUBJUB_FIELD_PRIME, 'R8.x out of field');
        assert(sig.R8[1] >= 0n && sig.R8[1] < BABYJUBJUB_FIELD_PRIME, 'R8.y out of field');
        assert(sig.S >= 0n && sig.S < BABYJUBJUB_SUBGROUP_ORDER, 'S out of subgroup');
        return `R8.x=0x${bigintToHex(sig.R8[0]).substring(0, 12)}… S=0x${bigintToHex(sig.S).substring(0, 12)}…`;
      });

      // T10: Signature determinism — sign same hash, expect same sig
      await runTest(results, 'T10 sign determinism', async () => {
        console.log('    Approve the SIGN request on your Ledger (same hash)…');
        const sig1 = await signer.sign(SIMPLE_HASH);

        console.log('    Approve again for determinism check…');
        const sig2 = await signer.sign(SIMPLE_HASH);

        assert(sig1.R8[0] === sig2.R8[0], 'R8.x differs');
        assert(sig1.R8[1] === sig2.R8[1], 'R8.y differs');
        assert(sig1.S === sig2.S, 'S differs');
        return 'two signatures match (deterministic EdDSA)';
      });

      // T11: Different hash → different signature
      await runTest(results, 'T11 different hash ≠ sig', async () => {
        console.log('    Approve SIGN for hash A…');
        const sigA = await signer.sign(SIMPLE_HASH);

        console.log('    Approve SIGN for hash B…');
        const sigB = await signer.sign(SIMPLE_HASH + 1n);

        const same = sigA.R8[0] === sigB.R8[0]
          && sigA.R8[1] === sigB.R8[1]
          && sigA.S === sigB.S;
        assert(!same, 'different hashes produced identical signatures');
        return 'different hashes → different signatures';
      });

      // T12: Sign reference test hash and verify the signature with circomlibjs
      // against the device's public key. This is the end-to-end correctness
      // check: it proves the on-device LE-decoded bigint equals the bigint the
      // host intended (otherwise verifyPoseidon would fail).
      await runTest(results, 'T12 sign reference hash + verify', async () => {
        // Natural BE reading of the hex string — no host-side reversal.
        const hashBytes = hexToBytes(TEST_HASH_HEX);
        let hashBigint = 0n;
        for (const b of hashBytes) hashBigint = (hashBigint << 8n) | BigInt(b);

        console.log('    Approve SIGN for reference hash…');
        const sig = await signer.sign(hashBigint);

        assert(sig.R8[0] >= 0n && sig.R8[0] < BABYJUBJUB_FIELD_PRIME, 'R8.x out of field');
        assert(sig.S >= 0n && sig.S < BABYJUBJUB_SUBGROUP_ORDER, 'S out of subgroup');

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const circom = (await import('@railgun-community/circomlibjs')) as any;
        const eddsa = circom.eddsa ?? circom.default?.eddsa;
        const ok = eddsa.verifyPoseidon(hashBigint, sig, [pubKey!.x, pubKey!.y]) as boolean;
        assert(ok, 'verifyPoseidon failed — device signed a different bigint than the host sent');

        return `reference hash signed + verified: S=0x${bigintToHex(sig.S).substring(0, 16)}…`;
      });

      // T13: Sign max-range hash (just under 2^256)
      await runTest(results, 'T13 sign large hash', async () => {
        const largeHash = (2n ** 256n) - 1n;
        console.log('    Approve SIGN for max-range hash…');
        const sig = await signer.sign(largeHash);
        assert(sig.S >= 0n && sig.S < BABYJUBJUB_SUBGROUP_ORDER, 'S out of subgroup');
        return 'max 32-byte hash signed successfully';
      });

      // T14: Sign zero hash
      await runTest(results, 'T14 sign zero hash', async () => {
        console.log('    Approve SIGN for zero hash…');
        const sig = await signer.sign(0n);
        assert(sig.R8[0] >= 0n && sig.R8[0] < BABYJUBJUB_FIELD_PRIME, 'R8.x out of field');
        assert(sig.S >= 0n && sig.S < BABYJUBJUB_SUBGROUP_ORDER, 'S out of subgroup');
        return 'zero hash signed successfully';
      });

      // T15: Raw SIGN_HASH APDU exchange (only if --raw)
      if (doRaw) {
        await runTest(results, 'T15 raw sign exchange', async () => {
          const hash = new Uint8Array(32);
          hash[31] = 0x01;
          // Data: account(4B) + hash(32B) = 36 bytes
          const payload = new Uint8Array(36);
          // payload[0..3] = account 0 (already zero)
          payload.set(hash, 4);
          const rawApdu = new Uint8Array(5 + payload.length);
          rawApdu[0] = RAILGUN_CLA;
          rawApdu[1] = RailgunAppINS.SIGN_HASH;
          rawApdu[2] = 0x00;
          rawApdu[3] = 0x00;
          rawApdu[4] = payload.length;
          rawApdu.set(payload, 5);

          console.log('    Approve raw SIGN request…');
          const rawResp = await transport.rawExchange(rawApdu);
          const resp = deserializeApduResponse(rawResp);

          assert(resp.statusWord === 0x9000, `SW=0x${resp.statusWord.toString(16)}`);
          assert(resp.data.length === SIGN_RESPONSE_LENGTH, `data ${resp.data.length} != ${SIGN_RESPONSE_LENGTH}`);

          // Skip 1-byte prefix, then decode R8x(32) + R8y(32) + S(32)
          let r8x = 0n;
          for (let i = 1; i < 33; i++) r8x = (r8x << 8n) | BigInt(resp.data[i]!);
          let s = 0n;
          for (let i = 65; i < 97; i++) s = (s << 8n) | BigInt(resp.data[i]!);

          assert(r8x < BABYJUBJUB_FIELD_PRIME, 'raw R8.x out of field');
          assert(s < BABYJUBJUB_SUBGROUP_ORDER, 'raw S out of subgroup');
          return 'raw 97-byte signature (prefix+96) valid';
        });
      }
    }

    // ── Close app ─────────────────────────────────────────────────────
    await runTest(results, 'T99 closeApp', async () => {
      await closeApp(transport);
      await sleep(500);
      const after = await getActiveApp(transport);
      assert(after === null, `still on ${after?.name ?? 'unknown'}`);
      return 'returned to dashboard';
    });
  } finally {
    await transport.disconnect();
  }

  printResults(results);
  if (results.some((r) => !r.passed)) process.exitCode = 1;
}

// ─── Test harness ─────────────────────────────────────────────────────────────

async function runTest(
  results: TestResult[],
  name: string,
  fn: () => Promise<string>,
): Promise<void> {
  const label = name.padEnd(28);
  try {
    const detail = await fn();
    console.log(`  ✓ ${label} ${detail}`);
    results.push({ name, passed: true, detail });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  ✗ ${label} ${msg}`);
    results.push({ name, passed: false, detail: msg });
  }
}

function printResults(results: TestResult[]): void {
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  const total = results.length;

  console.log('\n╔════════════════════════════════════════════════╗');
  console.log('║   RAILGUN Live Test Results                   ║');
  console.log('╠════════════════════════════════════════════════╣');

  for (const r of results) {
    const icon = r.passed ? '✓' : '✗';
    const pad = r.name.padEnd(28);
    console.log(`║ ${icon} ${pad} ${r.detail}`);
  }

  console.log('╠════════════════════════════════════════════════╣');
  console.log(`║ ${passed} passed, ${failed} failed, ${total} total`);
  console.log('╚════════════════════════════════════════════════╝');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
