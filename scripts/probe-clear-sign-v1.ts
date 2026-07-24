/**
 * Device probe for RAILGUN clear-sign-v1 firmware.
 *
 * Empirically resolves the open APDU questions on a REAL Ledger (Flex / Nano S
 * Plus) instead of relying on the docs — which contradict each other between
 * `js/README.md`, `js/test-7702.html`, and `js/clear-sign-apdus.js`.
 *
 * Prerequisites:
 *  - Ledger connected via USB, unlocked, and the RAILGUN app OPEN.
 *  - The clear-sign-v1 build installed:  yarn install:app --target flex|nanosp
 *
 * Usage (run on the HOST, where the device is plugged in):
 *   npx tsx scripts/probe-clear-sign-v1.ts               # reads: version, P1 matrix, 7702 addresses, sub-cmds
 *   npx tsx scripts/probe-clear-sign-v1.ts --clearsign   # + single-tx CLEAR_SIGN unshield (approve on device)
 *   npx tsx scripts/probe-clear-sign-v1.ts --dual        # + dual-tx / txToken!=feeToken FINALIZE length
 *
 * Safety: only READS public keys/addresses and signs THROWAWAY hashes / dummy
 * transacts that are NEVER broadcast. Approve or Reject each prompt on-device.
 * The viewing PRIVATE key (0x13) is fetched but NOT printed.
 *
 * Send me the full console output and it answers, empirically:
 *   A. the 7702 slot semantics + derived addresses (README vs test-7702.html)
 *   B. the CLEAR_SIGN single-tx FINALIZE layout + OUT_* response sizes
 *   C. the key-retrieval P1 matrix (0x01/0x10/0x13/0x14)
 *   D. whether sub-commands 0x19/0x1A and dual-tx CS_INIT are accepted
 */

import { NodeHIDTransport } from '../src/core/transport/nodehid-transport.js';
import { keccak_256 } from '@noble/hashes/sha3.js';

const argv = process.argv.slice(2);
const RUN_CLEARSIGN = argv.includes('--clearsign');
const RUN_DUAL = argv.includes('--dual');

// ─── hex helpers ───────────────────────────────────────────────────────────
const toHex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const fromHex = (h: string): Uint8Array => Uint8Array.from(Buffer.from(h.replace(/\s/g, ''), 'hex'));
const u32be = (v: number): string => (v >>> 0).toString(16).padStart(8, '0');
/** 12-byte 7702 path suffix W0||W1||W2 (each uint32 BE). */
const suffix = (w0: number, w1: number, w2: number): string => u32be(w0) + u32be(w1) + u32be(w2);
/** account(4B BE). */
const acct = (a: number): string => u32be(a);

let transport: NodeHIDTransport;

type Probe = { readonly sw: string; readonly data: Uint8Array; readonly ok: boolean };

/** Send a raw APDU, print the exchange, and return {sw, data}. Never throws on a non-9000 SW. */
async function ex(label: string, apduHex: string, note = ''): Promise<Probe> {
  process.stdout.write(`\n[${label}]${note ? ` ${note}` : ''}\n  → ${apduHex}\n`);
  try {
    const resp = await transport.rawExchange(fromHex(apduHex));
    const sw = toHex(resp.subarray(resp.length - 2));
    const data = resp.subarray(0, resp.length - 2);
    const shown = data.length ? `  data(${data.length}B)=${toHex(data).slice(0, 80)}${data.length > 40 ? '…' : ''}` : '';
    process.stdout.write(`  ← SW ${sw}${shown}\n`);
    return { sw, data, ok: sw === '9000' };
  } catch (err) {
    process.stdout.write(`  ← ERROR ${(err as Error).message}\n`);
    return { sw: 'ERR', data: new Uint8Array(0), ok: false };
  }
}

/** Ethereum address from a 65-byte uncompressed secp256k1 pubkey (04||X||Y). */
function ethAddress(pub65: Uint8Array): string {
  if (pub65.length !== 65 || pub65[0] !== 0x04) return '(unexpected pubkey shape)';
  return '0x' + toHex(keccak_256(pub65.subarray(1)).subarray(12));
}

const CLA = 'e0';
const INS_CLEAR_SIGN = '11';
function csApdu(p1Hex: string, dataHex: string): string {
  const lc = (dataHex.length / 2).toString(16).padStart(2, '0');
  return CLA + INS_CLEAR_SIGN + p1Hex + '00' + lc + dataHex;
}

// ─── main ────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log('═══ RAILGUN clear-sign-v1 device probe ═══');
  console.log('Ensure the RAILGUN app is OPEN. Approve/Reject prompts on the device.\n');

  transport = new NodeHIDTransport(120_000);
  await transport.connect();

  // ── Preflight: app name + version ──────────────────────────────────────────
  console.log('── Preflight ──');
  const name = await ex('GET_APP_NAME 0x04', 'e004000000');
  if (name.ok) console.log(`  app name = "${Buffer.from(name.data).toString('ascii')}"`);
  const ver = await ex('GET_VERSION 0x03', 'e003000000');
  if (ver.ok && ver.data.length >= 3) {
    console.log(`  RAILGUN app version = ${ver.data[0]}.${ver.data[1]}.${ver.data[2]}  (this is the APP version, not the Ledger firmware target)`);
  }

  // ── Section 1: key-retrieval P1 matrix ─────────────────────────────────────
  console.log('\n── Section 1: key-retrieval P1 matrix (0x01 / 0x13 / 0x10 / 0x14) ──');
  console.log('   Expectation to confirm: pubkey/address cmds require P1=0x01; viewing PRIVKEY (0x13) stays P1=0x00.');
  await ex('SPENDING_PUBKEY 0x01 P1=00', 'e0010000' + '04' + acct(0), 'expect REJECT 6a86 if prod requires P1=01');
  await ex('SPENDING_PUBKEY 0x01 P1=01', 'e0010100' + '04' + acct(0), 'APPROVE on device → 64B (x||y)');
  await ex('VIEWING_PRIVKEY 0x13 P1=00', 'e0130000' + '04' + acct(0), 'APPROVE → 32B (NOT printed); expect 9000');
  await ex('VIEWING_PRIVKEY 0x13 P1=01', 'e0130100' + '04' + acct(0), 'expect REJECT 6a86 (privkey stays P1=00)');
  const vpub = await ex('VIEWING_PUBKEY 0x10 P1=01', 'e0100100' + '04' + acct(0), 'APPROVE → 32B compressed Ed25519');
  if (vpub.ok) console.log(`  viewing pubkey = ${toHex(vpub.data)}`);
  await ex('VIEWING_PUBKEY 0x10 P1=00', 'e0100000' + '04' + acct(0), 'probe: silent-ok or reject?');
  const addr = await ex('RAILGUN_ADDRESS 0x14 P1=01', 'e0140100' + '04' + acct(0), 'APPROVE → 127B 0zk1… address');
  if (addr.ok) console.log(`  0zk address = ${Buffer.from(addr.data).toString('ascii')}`);
  await ex('RAILGUN_ADDRESS 0x14 P1=00', 'e0140000' + '04' + acct(0), 'probe: silent-ok or reject?');

  // ── Section 2: 7702 EOA derivation — the slot-semantics question ───────────
  console.log('\n── Section 2: 7702 EOA addresses (INS 0x07 P1=00, silent) ──');
  console.log('   COMPARE the slot (0,0,0) address to the firmware author\'s tooling (test-7702.html default).');
  console.log('   Slot (0,1,0) is what THIS client currently derives for a chainId=1 authorization.');
  for (const [w0, w1, w2, tag] of [
    [0, 0, 0, 'default slot'],
    [0, 1, 0, 'W1=1  (client puts chainId here)'],
    [1, 0, 0, 'W0=1'],
    [0, 0, 1, 'W2=1'],
  ] as const) {
    const r = await ex(`GET_7702_PUBKEY 0x07 slot(${w0},${w1},${w2})`, 'e0070000' + '0c' + suffix(w0, w1, w2), tag);
    if (r.ok) console.log(`  → address(${w0},${w1},${w2}) = ${ethAddress(r.data)}`);
  }

  // ── Section 2b: SIGN_TX_HASH P1 semantics (armed/gated vs standalone) ───────
  console.log('\n── Section 2b: SIGN_TX_HASH 0x09 P1=00 UNARMED (no preceding auth) ──');
  console.log('   README: only P1=01 accepted (P1=00 → 6a86). test-7702.html: P1=00 is a valid gated mode.');
  const dummyHash = '8c1f26718227707c6e5c61417b47daccafabca9f574c16e1521dd6a9c70d8405';
  await ex('SIGN_TX_HASH 0x09 P1=00 (unarmed)', 'e0090000' + '2c' + suffix(0, 0, 0) + dummyHash,
    'expect 6a86 (README) OR a not-armed error (gated) — NOT a signature');

  // ── Section 3: CLEAR_SIGN sub-command support probe (0x19 / 0x1A) ───────────
  console.log('\n── Section 3: CLEAR_SIGN sub-command support (0x19 BP_ADAPT, 0x1A GET_SHIELD_CT) ──');
  console.log('   6d00/6a86 ≈ not supported / wrong state; a "known-subcmd" SW ≈ present.');
  await ex('CLEAR_SIGN P1=19 (probe)', csApdu('19', '00'), 'BP_FIELDS_ADAPT_UNSHIELD_BASE — supported?');
  await ex('CLEAR_SIGN P1=1a (probe)', csApdu('1a', '00'), 'GET_SHIELD_CT — supported?');

  // ── Section 4: dual-tx CS_INIT format probe (always cheap) ─────────────────
  console.log('\n── Section 4: CLEAR_SIGN CS_INIT format (single-tx 38B vs multi-tx 88B) ──');
  const merkle = '11'.repeat(32);
  const singleInit = acct(0) + merkle + '01' + '01';                    // 38B: account||root||nIn||nOut
  const multiInit = acct(0) + '02' + '00'.repeat(15)                    // account||nTx||walletSource(15)
    + merkle + '01' + '02'                                              // tx0: root||nIn||nOut
    + '22'.repeat(32) + '01' + '02';                                    // tx1: root||nIn||nOut
  await ex('CS_INIT single-tx (38B)', csApdu('00', singleInit), 'does firmware still accept the 1-tx init?');
  await ex('CS_INIT multi-tx nTx=2 (88B)', csApdu('00', multiInit), 'is this the txToken!=feeToken init?');

  // ── Section 5 (--clearsign): single-tx unshield golden → FINALIZE layout ────
  if (RUN_CLEARSIGN) {
    console.log('\n── Section 5 (--clearsign): README 1×1 unshield golden sequence ──');
    console.log('   Validates the client builders + parseClearSignFinalize on-device. Approve the review at FINALIZE.');
    const steps: ReadonlyArray<readonly [string, string]> = [
      ['CS_INIT', 'e0110000260000000011111111111111111111111111111111111111111111111111111111111111110101'],
      ['NULLIFIER', 'e0112000202222222222222222222222222222222222222222222222222222222222222222'],
      ['BP_FIELDS', 'e011100045000000000000000001000000000000000100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000'],
      ['OUT_UNSHIELD', 'e011330054d8da6bf26964af9d7eed9e03e53415d37aa960450000000000000000000000006b175474e89094c44da98b954eedeac495271d0f0000000000000000000000000000000000000000000000000000000000040000'],
      ['FINALIZE', 'e01140000100'],
    ];
    let fin: Probe | undefined;
    for (const [label, apdu] of steps) fin = await ex(`CLEAR_SIGN ${label}`, apdu, label === 'FINALIZE' ? 'APPROVE the review on-device' : '');
    if (fin?.ok) {
      const d = fin.data;
      console.log(`\n  FINALIZE response = ${d.length}B  (expect 129: sig_len(1)=0x60 || R8x || R8y || S || msgHash)`);
      if (d.length === 129) {
        const prefix = d[0] ?? 0;
        console.log(`    sig_len prefix = 0x${prefix.toString(16)}  ${prefix === 0x60 ? '(0x60 ✓)' : '(NOT 0x60!)'}`);
        console.log(`    msgHash = ${toHex(d.subarray(97, 129))}`);
      }
    }
  } else {
    console.log('\n(skip single-tx CLEAR_SIGN — pass --clearsign to run the unshield golden + FINALIZE layout)');
  }

  // ── Section 6 (--dual): dual-tx FINALIZE length (192 vs 256) ────────────────
  if (RUN_DUAL) {
    console.log('\n── Section 6 (--dual): dual-tx (txToken != feeToken) → FINALIZE length ──');
    console.log('   Resolves the 192-vs-256 contradiction in clear-sign-apdus.js. Dummy data; approve the review.');
    const zk = Buffer.from('0zk1' + 'q'.repeat(123), 'ascii').toString('hex');   // 127-char 0zk
    const tokenHash = '00'.repeat(12) + '6b175474e89094c44da98b954eedeac495271d0f';
    const val = '00'.repeat(31) + '05';
    const bp = '0000' + '000000000000' + '00' + '0000000000000001' + '00'.repeat(20) + '00'.repeat(32);
    const seq: ReadonlyArray<readonly [string, string, string]> = [
      ['CS_INIT nTx=2', '00', multiInit],
      // tx0: value transfer (token A)
      ['NULLIFIER a0', '20', '33'.repeat(32)],
      ['BP_FIELDS a', '10', bp],
      ['OUT_CHANGE a', '31', tokenHash + val + '0000' + '0000'],
      ['OUT_TRANSFER a', '32', zk + tokenHash + val + '00' + '0000'],
      // tx1: broadcaster fee (token B)
      ['NULLIFIER b0', '20', '44'.repeat(32)],
      ['BP_FIELDS b', '10', bp],
      ['OUT_CHANGE b', '31', tokenHash + val + '0000' + '0000'],
      ['OUT_BROADCASTER b', '30', 'aa'.repeat(32) + 'bb'.repeat(32) + tokenHash + val + '0000' + '0000'],
      ['FINALIZE', '40', '00'],
    ];
    let fin: Probe | undefined;
    for (const [label, p1, data] of seq) fin = await ex(`CLEAR_SIGN ${label}`, csApdu(p1, data), label === 'FINALIZE' ? 'APPROVE the review on-device' : '');
    if (fin?.ok) {
      console.log(`\n  DUAL FINALIZE response = ${fin.data.length}B  →  192 = two triples (no msgHash) | 256 = two quads (with msgHash)`);
    }
  } else {
    console.log('\n(skip dual-tx — pass --dual to resolve the 192-vs-256 FINALIZE-length contradiction)');
  }

  console.log('\n═══ probe complete — send me the full output above ═══');
}

main()
  .catch((err) => {
    console.error('\nProbe failed:', (err as Error).message);
    process.exitCode = 1;
  })
  .finally(() => {
    void transport?.disconnect();
  });
