/**
 * Tests for the SCP orchestration functions in src/core/installer/.
 *
 * Covers three previously-untested code paths:
 *   1. getDeployedSecretV2  (scp.ts) — the v2/v3 handshake driver.
 *   2. createScpSession     (scp.ts) — the v2/v3 session factory.
 *   3. primeDevice          (prime.ts) — the device priming poll loop.
 *
 * The pure crypto core (crypto.ts, APDU/ELF parsers, and the ScpV2Session /
 * ScpV3Session wrap/unwrap classes) is already exhaustively covered by
 * installer.test.ts — this file deliberately does NOT re-test any of that.
 *
 * Unit tests — no device required. Drives MockTransport's queue.
 */

import { describe, it, expect, vi } from 'vitest';
import { MockTransport } from '../integration/mock-transport.js';
import { StatusWord } from '../../src/core/transport/types.js';
import type { ApduResponse } from '../../src/core/transport/types.js';
import type { InstallProgress } from '../../src/core/installer/types.js';
import {
  getDeployedSecretV2,
  createScpSession,
  ScpV2Session,
  ScpV3Session,
} from '../../src/core/installer/scp.js';
import {
  getPublicKey,
  signSha256Der,
  randomPrivateKey,
  randomBytes,
} from '../../src/core/installer/crypto.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build an ApduResponse with a given (or SUCCESS) status word. */
function resp(data: Uint8Array, statusWord: number = StatusWord.SUCCESS): ApduResponse {
  return { data, statusWord };
}

/** Empty-data response with SUCCESS (0x9000) — used for ack/finalize steps. */
function ok(): ApduResponse {
  return { data: new Uint8Array(0), statusWord: StatusWord.SUCCESS };
}

/**
 * LV-encode a device certificate exactly the way parseLv reads it in
 * getDeployedSecretV2:  [headerLen] header  [pubLen] pub  [sigLen] sig.
 * Every field is < 256 bytes (pub = 65, DER sig = ~70), so a single-byte
 * length prefix is always safe.
 */
function buildCert(header: Uint8Array, pub: Uint8Array, sig: Uint8Array): Uint8Array {
  const out = new Uint8Array(1 + header.length + 1 + pub.length + 1 + sig.length);
  let o = 0;
  out[o++] = header.length;
  out.set(header, o);
  o += header.length;
  out[o++] = pub.length;
  out.set(pub, o);
  o += pub.length;
  out[o++] = sig.length;
  out.set(sig, o);
  return out;
}

/**
 * Queue the first four handshake steps that are identical for every completing
 * handshake:
 *   1. target-ID ack       (0xe0 0x04)  → empty 9000
 *   2. get-nonce            (0xe0 0x50)  → 12-byte authInfo (deviceNonce = [4:12])
 *   3. signer-cert ack      (0xe0 0x51 p1=0x00) → empty 9000
 *   4. ephemeral-cert ack   (0xe0 0x51 p1=0x80) → empty 9000
 * The caller then queues the two cert-chain (step 5) responses and the finalize
 * (step 6) response.
 */
function enqueueHandshakePreamble(transport: MockTransport): void {
  const authInfo = new Uint8Array(12); // >= 12 bytes; contents irrelevant to these tests
  transport.enqueueResponses([ok(), resp(authInfo), ok(), ok()]);
}

/** A ready-status response for primeDevice (data is empty; only SW matters). */
function primeReady(sw: number): ApduResponse {
  return { data: new Uint8Array(0), statusWord: sw };
}

// ─── getDeployedSecretV2 ────────────────────────────────────────────────────

describe('getDeployedSecretV2', () => {
  it('rejects a target ID that does not support SCP V2 (& 0xf < 2)', async () => {
    const transport = new MockTransport();
    await transport.connect();

    // Guard fires before any exchange — no queued responses are consumed.
    await expect(
      getDeployedSecretV2(transport, randomPrivateKey(), 0x00000001),
    ).rejects.toThrow(/does not support SCP V2/i);

    expect(transport.queuedResponses).toBe(0);
  });

  it('rejects auth info shorter than 12 bytes', async () => {
    const transport = new MockTransport();
    await transport.connect();

    // Step 1 ok, step 2 returns a too-short authInfo (< 12 bytes).
    transport.enqueueResponses([ok(), resp(new Uint8Array(8))]);

    await expect(
      getDeployedSecretV2(transport, randomPrivateKey(), 0x00000002),
    ).rejects.toThrow(/Invalid auth info/i);
  });

  it('rejects a non-9000 status mid-handshake', async () => {
    const transport = new MockTransport();
    await transport.connect();

    // Step 1 returns a busy status word → exchangeExpect9000 throws.
    transport.enqueueResponse(resp(new Uint8Array(0), 0x6615));

    await expect(
      getDeployedSecretV2(transport, randomPrivateKey(), 0x00000002),
    ).rejects.toThrow(/SCP handshake failed/i);
  });

  /**
   * C3 — index-0 trust anchor is accepted UNVERIFIED.
   *
   * !!!  THIS ASSERTS THE CURRENT (C3-VULNERABLE) BEHAVIOR  !!!
   *
   * At scp.ts:300-303 the signature check result `ok` is only enforced when
   * `index > 0`. For index 0 (the root/trust-anchor certificate) a broken
   * signature is silently accepted and its public key becomes the ECDH peer.
   * Here index 0 carries a valid pubkey P0 but a well-formed-but-WRONG DER
   * signature (produced by an unrelated key over unrelated data, so
   * verifySha256Der returns `false` cleanly rather than throwing), and the
   * index-1 response is EMPTY so the loop `continue`s past it.
   *
   * We assert the handshake COMPLETES and returns a secret.
   *
   * WHEN C3 IS FIXED (index 0 becomes verified), this expectation MUST FLIP to
   * `await expect(...).rejects.toThrow(/Broken certificate chain/i)`.
   */
  it('C3: accepts an UNVERIFIED index-0 trust anchor (current vulnerable behavior)', async () => {
    const transport = new MockTransport();
    await transport.connect();

    const p0 = randomPrivateKey();
    const pub0 = getPublicKey(p0); // valid secp256k1 point → feeds deriveEcdhSecret

    // Well-formed but wrong signature: unrelated key over unrelated data.
    const wrongSig = signSha256Der(randomPrivateKey(), new Uint8Array([0xde, 0xad]));
    const cert0 = buildCert(new Uint8Array([0xaa, 0xbb]), pub0, wrongSig);

    enqueueHandshakePreamble(transport);
    transport.enqueueResponses([
      resp(cert0), // step 5, index 0 — bad sig, accepted anyway (the C3 gap)
      ok(), // step 5, index 1 — EMPTY data → loop `continue`s (skips verification)
      ok(), // step 6, finalize
    ]);

    // v2 target (& 0xf === 2) → returns a 16-byte Uint8Array.
    const secret = await getDeployedSecretV2(transport, randomPrivateKey(), 0x00000002);

    expect(secret).toBeInstanceOf(Uint8Array);
    expect((secret as Uint8Array).length).toBe(16);
  });

  it('DOES verify index 1: a broken index-1 signature aborts the handshake', async () => {
    const transport = new MockTransport();
    await transport.connect();

    // index 0: valid pub, wrong-but-well-formed sig (accepted per the C3 gap).
    const pub0 = getPublicKey(randomPrivateKey());
    const cert0 = buildCert(
      new Uint8Array([0x01]),
      pub0,
      signSha256Der(randomPrivateKey(), new Uint8Array([0x00])),
    );

    // index 1: valid pub, wrong-but-well-formed sig → `ok` is false AND index > 0.
    const pub1 = getPublicKey(randomPrivateKey());
    const cert1 = buildCert(
      new Uint8Array([0x02]),
      pub1,
      signSha256Der(randomPrivateKey(), new Uint8Array([0x01])),
    );

    enqueueHandshakePreamble(transport);
    transport.enqueueResponses([
      resp(cert0), // index 0
      resp(cert1), // index 1 — enforced
      // no finalize response needed; it throws before step 6
    ]);

    await expect(
      getDeployedSecretV2(transport, randomPrivateKey(), 0x00000002),
    ).rejects.toThrow(/Broken certificate chain/i);
  });

  it('returns the v3 secret shape { ecdhSecret, devicePublicKey } for a v3 target', async () => {
    const transport = new MockTransport();
    await transport.connect();

    const pub0 = getPublicKey(randomPrivateKey());
    const cert0 = buildCert(
      new Uint8Array([0x01]),
      pub0,
      signSha256Der(randomPrivateKey(), new Uint8Array([0x00])),
    );

    enqueueHandshakePreamble(transport);
    transport.enqueueResponses([
      resp(cert0), // index 0 — valid pub, sig ignored at index 0
      ok(), // index 1 — empty → continue
      ok(), // finalize
    ]);

    // v3 target (& 0xf === 4 > 2) → object result.
    const result = await getDeployedSecretV2(transport, randomPrivateKey(), 0x33100004);

    expect(result).not.toBeInstanceOf(Uint8Array);
    // Narrow to the object variant.
    if (result instanceof Uint8Array) {
      throw new Error('expected v3 object result, got Uint8Array');
    }
    expect(result.ecdhSecret).toBeInstanceOf(Uint8Array);
    expect(result.devicePublicKey).toBeInstanceOf(Uint8Array);
    expect(result.ecdhSecret.length).toBe(32); // SHA-256 of the shared point
    // devicePublicKey is the index-0 pub (last non-empty cert public key).
    expect(result.devicePublicKey).toEqual(pub0);
  });
});

// ─── createScpSession ─────────────────────────────────────────────────────────

describe('createScpSession', () => {
  it('builds a v2 session from a 16-byte secret', () => {
    const session = createScpSession(randomBytes(16));
    expect(session.version).toBe(2);
    expect(session.channel).toBeInstanceOf(ScpV2Session);
  });

  it('builds a v3 session from an { ecdhSecret, devicePublicKey } result', () => {
    const session = createScpSession({
      ecdhSecret: randomBytes(32),
      devicePublicKey: getPublicKey(randomPrivateKey()),
    });
    expect(session.version).toBe(3);
    expect(session.channel).toBeInstanceOf(ScpV3Session);
  });

  it('produces a working v3 channel that round-trips wrap → unwrap', () => {
    // Two sessions built from the SAME secret mirror device/host wrap/unwrap:
    // one wraps, a fresh peer unwraps (matching installer.test.ts's pattern).
    const ecdhSecret = randomBytes(32);
    const devicePublicKey = getPublicKey(randomPrivateKey());

    const wrapSide = createScpSession({ ecdhSecret, devicePublicKey });
    const unwrapSide = createScpSession({ ecdhSecret, devicePublicKey });

    const data = new Uint8Array([0x10, 0x20, 0x30, 0x40, 0x50]);
    const wrapped = wrapSide.channel.wrap(data);
    expect(wrapped).not.toEqual(data);

    const unwrapped = unwrapSide.channel.unwrap(wrapped);
    expect(unwrapped).toEqual(data);
  });

  it('produces a working v2 channel that round-trips wrap → unwrap', () => {
    const secret = randomBytes(16);
    const wrapSide = createScpSession(secret);
    const unwrapSide = createScpSession(secret);

    const data = new Uint8Array([0xaa, 0xbb, 0xcc]);
    const wrapped = wrapSide.channel.wrap(data);
    const unwrapped = unwrapSide.channel.unwrap(wrapped);
    expect(unwrapped).toEqual(data);
  });
});

// ─── primeDevice ────────────────────────────────────────────────────────────

describe('primeDevice', () => {
  // Import lazily inside the block to keep the top-of-file import list tidy and
  // grouped with the priming tests it belongs to.
  const importPrime = async (): Promise<
    typeof import('../../src/core/installer/prime.js')
  > => import('../../src/core/installer/prime.js');

  it('resolves on the first attempt when the device is ready (0x9000)', async () => {
    const { primeDevice } = await importPrime();
    const transport = new MockTransport();
    await transport.connect();
    transport.enqueueResponse(primeReady(0x9000));

    const events: InstallProgress[] = [];
    await expect(
      primeDevice(transport, 3, 1, (p) => events.push(p)),
    ).resolves.toBeUndefined();

    expect(events).toHaveLength(1);
    expect(events[0]!.phase).toBe('priming');
    // One attempt consumed exactly one queued response.
    expect(transport.queuedResponses).toBe(0);
  });

  it('treats 0x6d00 (INS not supported) as ready', async () => {
    const { primeDevice } = await importPrime();
    const transport = new MockTransport();
    await transport.connect();
    transport.enqueueResponse(primeReady(0x6d00));

    const events: InstallProgress[] = [];
    await expect(
      primeDevice(transport, 3, 1, (p) => events.push(p)),
    ).resolves.toBeUndefined();
    expect(events).toHaveLength(1);
    expect(events[0]!.phase).toBe('priming');
  });

  it('treats 0x6e00 (CLA not supported) as ready', async () => {
    const { primeDevice } = await importPrime();
    const transport = new MockTransport();
    await transport.connect();
    transport.enqueueResponse(primeReady(0x6e00));

    await expect(primeDevice(transport, 3, 1)).resolves.toBeUndefined();
  });

  it('retries on 0x5515 then 0x6615, then succeeds on 0x9000', async () => {
    const { primeDevice } = await importPrime();
    const transport = new MockTransport();
    await transport.connect();
    transport.enqueueResponses([
      primeReady(0x5515), // busy → retry
      primeReady(0x6615), // busy → retry
      primeReady(0x9000), // ready
    ]);

    const events: InstallProgress[] = [];
    // delayMs = 1 keeps the sleeps effectively instant and deterministic.
    await expect(
      primeDevice(transport, 5, 1, (p) => events.push(p)),
    ).resolves.toBeUndefined();

    // All three responses consumed; two "waiting" events + one "ready" event.
    expect(transport.queuedResponses).toBe(0);
    expect(events).toHaveLength(3);
    expect(events[events.length - 1]!.message).toMatch(/ready/i);
  });

  it('returns on an unknown status word (device is responding)', async () => {
    const { primeDevice } = await importPrime();
    const transport = new MockTransport();
    await transport.connect();
    // 0x6a80 is neither a ready-code nor a busy-code → the `return` fallthrough.
    transport.enqueueResponse(primeReady(0x6a80));

    const events: InstallProgress[] = [];
    await expect(
      primeDevice(transport, 3, 1, (p) => events.push(p)),
    ).resolves.toBeUndefined();

    // Unknown-status path returns WITHOUT emitting a progress event.
    expect(events).toHaveLength(0);
    expect(transport.queuedResponses).toBe(0);
  });

  it('throws after attempts are exhausted with the device always busy', async () => {
    const { primeDevice } = await importPrime();
    const transport = new MockTransport();
    await transport.connect();
    transport.enqueueResponses([
      primeReady(0x5515),
      primeReady(0x5515),
      primeReady(0x5515),
    ]);

    await expect(primeDevice(transport, 3, 1)).rejects.toThrow(/did not become ready/i);
    // Exactly `attempts` responses consumed.
    expect(transport.queuedResponses).toBe(0);
  });

  it('catches a rejected rawExchange and retries, then succeeds', async () => {
    const { primeDevice } = await importPrime();
    const transport = new MockTransport();
    await transport.connect();

    // First rawExchange throws, second returns ready. Spy wraps the real impl.
    const real = transport.rawExchange.bind(transport);
    let calls = 0;
    vi.spyOn(transport, 'rawExchange').mockImplementation(async (apdu) => {
      calls++;
      if (calls === 1) {
        throw new Error('transient transport error');
      }
      return real(apdu);
    });
    transport.enqueueResponse(primeReady(0x9000));

    await expect(primeDevice(transport, 3, 1)).resolves.toBeUndefined();
    expect(calls).toBe(2);
  });
});
