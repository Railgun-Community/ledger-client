/**
 * Integration tests — end-to-end flows through state machine + signers.
 *
 * These tests exercise the full stack (minus real hardware):
 * - State machine transition sequences
 * - RailgunSigner through MockTransport
 * - LedgerHardwareConnector through MockTransport
 * - Error recovery flows
 * - Batch signing sequence
 *
 * No React rendering — pure logic integration.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { transition, createInitialContext } from '../../src/core/state-machine/machine.js';
import type {
  MachineState,
  MachineContext,
  MachineEvent,
} from '../../src/core/state-machine/types.js';
import { RailgunSigner } from '../../src/core/signers/railgun-signer.js';
import { createLedgerConnector } from '../../src/core/connector/ledger-connector.js';
import { MockTransport } from './mock-transport.js';
import { successResponse, errorResponse } from '../fixtures/apdu-responses.js';
import { StatusWord } from '../../src/core/transport/types.js';
import { HWError, HWErrorCode } from '../../src/core/errors.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function step(
  m: { state: MachineState; context: MachineContext },
  event: MachineEvent,
): { state: MachineState; context: MachineContext } {
  const result = transition(m.state, m.context, event);
  return { state: result.state, context: result.context };
}

function appAndVersionResponse(name: string, version: string) {
  const nameBytes = new TextEncoder().encode(name);
  const versionBytes = new TextEncoder().encode(version);
  const data = new Uint8Array(1 + 1 + nameBytes.length + 1 + versionBytes.length);
  let offset = 0;
  data[offset++] = 0x01;
  data[offset++] = nameBytes.length;
  data.set(nameBytes, offset);
  offset += nameBytes.length;
  data[offset++] = versionBytes.length;
  data.set(versionBytes, offset);
  return successResponse(data);
}

function validSignResponse(r8x = 0n, r8y = 1n, s = 7n) {
  const data = new Uint8Array(97);
  data[0] = 0x00; // prefix byte
  writeBE(data, 1, r8x);
  writeBE(data, 33, r8y);
  writeBE(data, 65, s);
  return successResponse(data);
}

function writeBE(buf: Uint8Array, offset: number, value: bigint) {
  for (let i = 31; i >= 0; i--) {
    buf[offset + i] = Number(value & 0xffn);
    value >>= 8n;
  }
}

function publicKeyResponse(x = 100n, y = 200n) {
  const data = new Uint8Array(64);
  writeBE(data, 0, x);
  writeBE(data, 32, y);
  return successResponse(data);
}

const MOCK_DEVICE_INFO = {
  targetId: 0x33000004,
  version: '2.1.0',
  flags: 0,
  mcuVersion: '1.12',
} as const;

const MOCK_APP_LIST = [
  { name: 'RAILGUN', version: '0.1.0' },
  { name: 'Ethereum', version: '1.12.1' },
] as const;

const MOCK_ACTIVE_APP = { name: 'RAILGUN', version: '0.1.0' } as const;

// ─── Full connection + sign flow ──────────────────────────────────────────────

describe('full connection → sign flow (state machine)', () => {
  it('walks through connect → query → app check → open → sign → disconnect', () => {
    let m = { state: 'disconnected' as MachineState, context: createInitialContext() };

    // Connect
    m = step(m, { type: 'CONNECT' });
    expect(m.state).toBe('connecting');

    // Transport connects
    m = step(m, { type: 'TRANSPORT_CONNECTED' });
    expect(m.state).toBe('querying_device');

    // Device info received
    m = step(m, { type: 'DEVICE_INFO_RECEIVED', info: MOCK_DEVICE_INFO });
    expect(m.state).toBe('device_ready');
    expect(m.context.deviceInfo).toEqual(MOCK_DEVICE_INFO);

    // App list received
    m = step(m, { type: 'APPS_LISTED', apps: MOCK_APP_LIST });
    expect(m.state).toBe('app_check');
    expect(m.context.installedApps).toHaveLength(2);

    // Manually move to app_found (caller determines app exists)
    m = { ...m, state: 'app_found' };
    m = step(m, { type: 'CONNECT' }); // trigger auto-transition
    expect(m.state).toBe('opening_app');

    // App opened
    m = step(m, { type: 'APP_OPENED', appInfo: MOCK_ACTIVE_APP });
    expect(m.state).toBe('signer_idle');
    expect(m.context.activeApp).toEqual(MOCK_ACTIVE_APP);
    expect(m.context.lastSafeState).toBe('signer_idle');

    // Sign request
    m = step(m, { type: 'SIGN_REQUEST', hash: 12345n });
    expect(m.state).toBe('reviewing');
    expect(m.context.pendingSignRequest?.hash).toBe(12345n);

    // Approve
    m = step(m, { type: 'APPROVE_SIGN' });
    expect(m.state).toBe('confirming');

    // Sign complete
    const sig = { R8: [42n, 99n] as const, S: 7n };
    m = step(m, { type: 'SIGN_COMPLETE', signature: sig });
    expect(m.state).toBe('signed');

    // Auto-transition back to idle
    m = step(m, { type: 'CONNECT' });
    expect(m.state).toBe('signer_idle');
    expect(m.context.pendingSignRequest).toBeNull();

    // Disconnect
    m = step(m, { type: 'DISCONNECT' });
    expect(m.state).toBe('disconnected');
    expect(m.context.transport).toBeNull();
  });
});

// ─── Error recovery full flow ─────────────────────────────────────────────────

describe('error recovery flow', () => {
  it('transport lost during sign → retry → back to signer_idle', () => {
    let m = {
      state: 'confirming' as MachineState,
      context: {
        ...createInitialContext(),
        lastSafeState: 'signer_idle' as MachineState,
        pendingSignRequest: { hash: 1n },
      },
    };

    // Transport disconnects
    m = step(m, { type: 'TRANSPORT_DISCONNECTED' });
    expect(m.state).toBe('error.transport_lost');
    expect(m.context.transport).toBeNull();

    // Retry → last safe state
    m = step(m, { type: 'RETRY' });
    expect(m.state).toBe('signer_idle');
    expect(m.context.error).toBeNull();
  });

  it('timeout → reset → disconnected (clean slate)', () => {
    let m = {
      state: 'confirming' as MachineState,
      context: createInitialContext(),
    };

    m = step(m, { type: 'TIMEOUT' });
    expect(m.state).toBe('error.timeout');

    m = step(m, { type: 'RESET' });
    expect(m.state).toBe('disconnected');
    expect(m.context.deviceInfo).toBeNull();
  });
});

// ─── Batch signing flow ───────────────────────────────────────────────────────

describe('batch signing end-to-end (state machine)', () => {
  it('walks through batch review → sign each → complete', () => {
    const requests = [
      { id: '1', description: 'tx1', publicInputs: { merkleRoot: 1n, boundParamsHash: 2n, nullifiers: [3n], commitmentsOut: [4n] }, hash: 10n },
      { id: '2', description: 'tx2', publicInputs: { merkleRoot: 5n, boundParamsHash: 6n, nullifiers: [7n], commitmentsOut: [8n] }, hash: 20n },
      { id: '3', description: 'tx3', publicInputs: { merkleRoot: 9n, boundParamsHash: 10n, nullifiers: [11n], commitmentsOut: [12n] }, hash: 30n },
    ];

    let m = {
      state: 'signer_idle' as MachineState,
      context: createInitialContext(),
    };

    // Batch request
    m = step(m, { type: 'BATCH_SIGN_REQUEST', requests });
    expect(m.state).toBe('batch_reviewing');
    expect(m.context.batchIndex).toBe(0);

    // Approve batch
    m = step(m, { type: 'APPROVE_BATCH' });
    expect(m.state).toBe('batch_signing_n');

    // Sign #1
    m = step(m, { type: 'SIGN_COMPLETE', signature: { R8: [1n, 2n], S: 3n } });
    expect(m.state).toBe('batch_signing_n');
    expect(m.context.batchIndex).toBe(1);

    // Sign #2
    m = step(m, { type: 'SIGN_COMPLETE', signature: { R8: [4n, 5n], S: 6n } });
    expect(m.state).toBe('batch_signing_n');
    expect(m.context.batchIndex).toBe(2);

    // Sign #3 (last)
    m = step(m, { type: 'SIGN_COMPLETE', signature: { R8: [7n, 8n], S: 9n } });
    expect(m.state).toBe('batch_complete');
    expect(m.context.batchSignatures).toHaveLength(3);
    expect(m.context.batchIndex).toBe(3);

    // Auto-transition to signer_idle — clears batch state
    m = step(m, { type: 'CONNECT' });
    expect(m.state).toBe('signer_idle');
    expect(m.context.pendingBatchRequests).toBeNull();
    // batch_complete auto-transition resets signatures
    expect(m.context.batchSignatures).toEqual([]);
    expect(m.context.batchIndex).toBe(0);
  });

  it('batch rejection at any point returns to signer_idle', () => {
    const requests = [
      { id: '1', description: 'tx1', publicInputs: { merkleRoot: 1n, boundParamsHash: 2n, nullifiers: [3n], commitmentsOut: [4n] }, hash: 10n },
    ];

    let m = {
      state: 'signer_idle' as MachineState,
      context: createInitialContext(),
    };

    m = step(m, { type: 'BATCH_SIGN_REQUEST', requests });
    m = step(m, { type: 'REJECT_BATCH' });
    expect(m.state).toBe('batch_rejected');

    // Auto-transition
    m = step(m, { type: 'CONNECT' });
    expect(m.state).toBe('signer_idle');
  });
});

// ─── RailgunSigner + MockTransport ────────────────────────────────────────────

describe('RailgunSigner integration with MockTransport', () => {
  let transport: MockTransport;
  let signer: RailgunSigner;

  beforeEach(async () => {
    transport = new MockTransport();
    await transport.connect();
    signer = new RailgunSigner({ transport });
  });

  it('full sign cycle: getPublicKey → sign', async () => {
    transport.enqueueResponse(publicKeyResponse());
    transport.enqueueResponse(validSignResponse());

    const pk = await signer.getPublicKey();
    expect(pk.x).toBe(100n);
    expect(pk.y).toBe(200n);

    const sig = await signer.sign(12345n);
    expect(sig.R8[0]).toBe(0n);
    expect(sig.R8[1]).toBe(1n);
    expect(sig.S).toBe(7n);

    expect(transport.sentCommands).toHaveLength(2);
  });

  it('sign failure: device rejects → HWError thrown', async () => {
    transport.enqueueResponse(errorResponse(StatusWord.USER_REJECTED));
    await expect(signer.sign(1n)).rejects.toThrow(HWError);
  });

  it('sign failure: transport disconnects mid-sign → Error thrown', async () => {
    await transport.disconnect();
    await expect(signer.sign(1n)).rejects.toThrow('not connected');
  });
});

// ─── LedgerConnector integration ──────────────────────────────────────────────

describe('LedgerConnector integration with MockTransport', () => {
  let transport: MockTransport;

  beforeEach(async () => {
    transport = new MockTransport();
    await transport.connect();
  });

  it('sign through connector: app check + sign', async () => {
    const connector = createLedgerConnector(transport, {
      appName: 'RAILGUN',
      minAppVersion: '0.1.0',
      derivationPath: "m/44'/0'/0'/0/0",
    });

    // getActiveApp APDU response
    transport.enqueueResponse(appAndVersionResponse('RAILGUN', '0.1.0'));
    // sign APDU response
    transport.enqueueResponse(validSignResponse());

    const sig = await connector.sign(12345n);
    expect(sig.R8[0]).toBe(0n);
    expect(sig.S).toBe(7n);
  });

  it('public key through connector', async () => {
    const connector = createLedgerConnector(transport, {
      appName: 'RAILGUN',
      minAppVersion: '0.1.0',
      derivationPath: "m/44'/0'/0'/0/0",
    });

    // getActiveApp
    transport.enqueueResponse(appAndVersionResponse('RAILGUN', '0.1.0'));
    // getPublicKey
    transport.enqueueResponse(publicKeyResponse(42n, 99n));

    const pk = await connector.getPublicKey();
    expect(pk.x).toBe(42n);
    expect(pk.y).toBe(99n);
  });

  it('connector rejects when wrong app is open', async () => {
    const connector = createLedgerConnector(transport, {
      appName: 'RAILGUN',
      minAppVersion: '0.1.0',
      derivationPath: "m/44'/0'/0'/0/0",
    });

    transport.enqueueResponse(appAndVersionResponse('Ethereum', '1.0.0'));
    const err = await connector.sign(1n).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HWError);
    expect((err as HWError).code).toBe(HWErrorCode.APP_OPEN_FAILED);
  });

  it('isConnected / disconnect flow', async () => {
    const connector = createLedgerConnector(transport, {
      appName: 'RAILGUN',
      minAppVersion: '0.1.0',
      derivationPath: "m/44'/0'/0'/0/0",
    });

    expect(connector.isConnected()).toBe(true);
    await connector.disconnect();
    expect(connector.isConnected()).toBe(false);
  });
});

// ─── Mode switching ───────────────────────────────────────────────────────────

describe('mode switching integration', () => {
  it('signer → installer → signer round trip', () => {
    let m = {
      state: 'signer_idle' as MachineState,
      context: createInitialContext(),
    };

    // Switch to installer
    m = step(m, { type: 'SWITCH_MODE', mode: 'installer' });
    expect(m.state).toBe('install_idle');
    expect(m.context.mode).toBe('installer');

    // Switch back to signer
    m = step(m, { type: 'SWITCH_MODE', mode: 'signer' });
    expect(m.state).toBe('signer_idle');
    expect(m.context.mode).toBe('signer');
  });
});
