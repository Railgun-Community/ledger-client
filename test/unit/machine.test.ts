/**
 * State machine transition tests.
 *
 * Tests the pure transition function with various state/event combinations.
 * No transport, no async — pure logic only.
 */

import { describe, it, expect } from 'vitest';
import { transition, createInitialContext } from '../../src/core/state-machine/machine.js';
import type { MachineContext, MachineState, MachineEvent } from '../../src/core/state-machine/types.js';
import { HWError, HWErrorCode } from '../../src/core/errors.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ctx(overrides?: Partial<MachineContext>): MachineContext {
  return { ...createInitialContext(), ...overrides };
}

function send(
  state: MachineState,
  context: MachineContext,
  event: MachineEvent,
) {
  return transition(state, context, event);
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

const MOCK_SIGNATURE = {
  R8: [100n, 200n] as const,
  S: 42n,
};

// ─── Connection flow ──────────────────────────────────────────────────────────

describe('connection flow', () => {
  it('disconnected → CONNECT → connecting', () => {
    const result = send('disconnected', ctx(), { type: 'CONNECT' });
    expect(result.state).toBe('connecting');
  });

  it('connecting → TRANSPORT_CONNECTED → querying_device', () => {
    const result = send('connecting', ctx(), { type: 'TRANSPORT_CONNECTED' });
    expect(result.state).toBe('querying_device');
  });

  it('querying_device → DEVICE_INFO_RECEIVED → device_ready', () => {
    const result = send('querying_device', ctx(), {
      type: 'DEVICE_INFO_RECEIVED',
      info: MOCK_DEVICE_INFO,
    });
    expect(result.state).toBe('device_ready');
    expect(result.context.deviceInfo).toEqual(MOCK_DEVICE_INFO);
  });

  it('device_ready → APPS_LISTED → app_check', () => {
    const result = send('device_ready', ctx({ deviceInfo: MOCK_DEVICE_INFO }), {
      type: 'APPS_LISTED',
      apps: MOCK_APP_LIST,
    });
    expect(result.state).toBe('app_check');
    expect(result.context.installedApps).toEqual(MOCK_APP_LIST);
  });
});

// ─── App check flow ───────────────────────────────────────────────────────────

describe('app check flow', () => {
  it('app_check → OPEN_APP_REQUEST → opening_app', () => {
    const result = send('app_check', ctx(), { type: 'OPEN_APP_REQUEST' });
    expect(result.state).toBe('opening_app');
  });

  it('opening_app → APP_OPENED → signer_idle', () => {
    const result = send('opening_app', ctx(), {
      type: 'APP_OPENED',
      appInfo: MOCK_ACTIVE_APP,
    });
    expect(result.state).toBe('signer_idle');
    expect(result.context.activeApp).toEqual(MOCK_ACTIVE_APP);
    expect(result.context.lastSafeState).toBe('signer_idle');
  });

  it('opening_app → DEVICE_REJECTED → error.user_rejected', () => {
    const result = send('opening_app', ctx(), { type: 'DEVICE_REJECTED' });
    expect(result.state).toBe('error.user_rejected');
  });
});

// ─── Single sign flow ─────────────────────────────────────────────────────────

describe('single sign flow', () => {
  it('signer_idle → SIGN_REQUEST → reviewing', () => {
    const result = send('signer_idle', ctx(), {
      type: 'SIGN_REQUEST',
      hash: 123n,
    });
    expect(result.state).toBe('reviewing');
    expect(result.context.pendingSignRequest).toEqual({
      hash: 123n,
      publicInputs: undefined,
    });
  });

  it('reviewing → APPROVE_SIGN → confirming', () => {
    const result = send('reviewing', ctx(), { type: 'APPROVE_SIGN' });
    expect(result.state).toBe('confirming');
  });

  it('reviewing → REJECT_SIGN → signer_idle (clears request)', () => {
    const c = ctx({ pendingSignRequest: { hash: 1n } });
    const result = send('reviewing', c, { type: 'REJECT_SIGN' });
    expect(result.state).toBe('signer_idle');
    expect(result.context.pendingSignRequest).toBeNull();
  });

  it('confirming → SIGN_COMPLETE → signed', () => {
    const result = send('confirming', ctx(), {
      type: 'SIGN_COMPLETE',
      signature: MOCK_SIGNATURE,
    });
    expect(result.state).toBe('signed');
  });

  it('confirming → DEVICE_REJECTED → sign_rejected', () => {
    const result = send('confirming', ctx(), { type: 'DEVICE_REJECTED' });
    expect(result.state).toBe('sign_rejected');
  });

  it('signed auto-transitions to signer_idle', () => {
    const c = ctx({ pendingSignRequest: { hash: 1n } });
    const result = send('signed', c, { type: 'CONNECT' }); // any event
    expect(result.state).toBe('signer_idle');
    expect(result.context.pendingSignRequest).toBeNull();
  });

  it('sign_rejected auto-transitions to signer_idle', () => {
    const c = ctx({ pendingSignRequest: { hash: 1n } });
    const result = send('sign_rejected', c, { type: 'CONNECT' });
    expect(result.state).toBe('signer_idle');
    expect(result.context.pendingSignRequest).toBeNull();
  });
});

// ─── Batch sign flow ──────────────────────────────────────────────────────────

describe('batch sign flow', () => {
  const batchRequests = [
    { id: '1', description: 'tx1', publicInputs: { merkleRoot: 1n, boundParamsHash: 2n, nullifiers: [3n], commitmentsOut: [4n] }, hash: 10n },
    { id: '2', description: 'tx2', publicInputs: { merkleRoot: 5n, boundParamsHash: 6n, nullifiers: [7n], commitmentsOut: [8n] }, hash: 20n },
  ];

  it('signer_idle → BATCH_SIGN_REQUEST → batch_reviewing', () => {
    const result = send('signer_idle', ctx(), {
      type: 'BATCH_SIGN_REQUEST',
      requests: batchRequests,
    });
    expect(result.state).toBe('batch_reviewing');
    expect(result.context.pendingBatchRequests).toBeDefined();
    expect(result.context.batchIndex).toBe(0);
    expect(result.context.batchSignatures).toEqual([]);
  });

  it('batch_reviewing → APPROVE_BATCH → batch_signing_n', () => {
    const result = send('batch_reviewing', ctx(), { type: 'APPROVE_BATCH' });
    expect(result.state).toBe('batch_signing_n');
  });

  it('batch_reviewing → REJECT_BATCH → batch_rejected', () => {
    const result = send('batch_reviewing', ctx(), { type: 'REJECT_BATCH' });
    expect(result.state).toBe('batch_rejected');
  });

  it('batch_signing_n → SIGN_COMPLETE (more left) → batch_signing_n', () => {
    const c = ctx({
      pendingBatchRequests: { requests: batchRequests },
      batchIndex: 0,
      batchSignatures: [],
    });
    const result = send('batch_signing_n', c, {
      type: 'SIGN_COMPLETE',
      signature: MOCK_SIGNATURE,
    });
    expect(result.state).toBe('batch_signing_n');
    expect(result.context.batchIndex).toBe(1);
    expect(result.context.batchSignatures).toHaveLength(1);
  });

  it('batch_signing_n → SIGN_COMPLETE (last) → batch_complete', () => {
    const c = ctx({
      pendingBatchRequests: { requests: batchRequests },
      batchIndex: 1,
      batchSignatures: [MOCK_SIGNATURE],
    });
    const result = send('batch_signing_n', c, {
      type: 'SIGN_COMPLETE',
      signature: MOCK_SIGNATURE,
    });
    expect(result.state).toBe('batch_complete');
    expect(result.context.batchSignatures).toHaveLength(2);
    expect(result.context.batchIndex).toBe(2);
  });

  it('batch_signing_n → DEVICE_REJECTED → batch_rejected', () => {
    const c = ctx({
      pendingBatchRequests: { requests: batchRequests },
      batchIndex: 0,
    });
    const result = send('batch_signing_n', c, { type: 'DEVICE_REJECTED' });
    expect(result.state).toBe('batch_rejected');
  });

  it('batch_complete auto-transitions to signer_idle', () => {
    const c = ctx({
      pendingBatchRequests: { requests: batchRequests },
      batchSignatures: [MOCK_SIGNATURE, MOCK_SIGNATURE],
      batchIndex: 2,
    });
    const result = send('batch_complete', c, { type: 'CONNECT' });
    expect(result.state).toBe('signer_idle');
    expect(result.context.pendingBatchRequests).toBeNull();
    expect(result.context.batchSignatures).toEqual([]);
    expect(result.context.batchIndex).toBe(0);
  });

  it('batch_rejected auto-transitions to signer_idle', () => {
    const c = ctx({ pendingBatchRequests: { requests: batchRequests } });
    const result = send('batch_rejected', c, { type: 'CONNECT' });
    expect(result.state).toBe('signer_idle');
    expect(result.context.pendingBatchRequests).toBeNull();
  });
});

// ─── Global transitions ───────────────────────────────────────────────────────

describe('global transitions', () => {
  const states: MachineState[] = [
    'connecting',
    'querying_device',
    'signer_idle',
    'reviewing',
    'confirming',
    'batch_signing_n',
  ];

  for (const s of states) {
    it(`TRANSPORT_DISCONNECTED from ${s} → error.transport_lost`, () => {
      const result = send(s, ctx(), { type: 'TRANSPORT_DISCONNECTED' });
      expect(result.state).toBe('error.transport_lost');
      expect(result.context.transport).toBeNull();
    });
  }

  it('TRANSPORT_ERROR → error.protocol_error', () => {
    const err = new HWError(HWErrorCode.APDU_INVALID_RESPONSE, 'bad');
    const result = send('signer_idle', ctx(), {
      type: 'TRANSPORT_ERROR',
      error: err,
    });
    expect(result.state).toBe('error.protocol_error');
    expect(result.context.error).toBe(err);
  });

  it('TIMEOUT → error.timeout', () => {
    const result = send('confirming', ctx(), { type: 'TIMEOUT' });
    expect(result.state).toBe('error.timeout');
  });

  it('DISCONNECT from any state → disconnected (full cleanup)', () => {
    const c = ctx({
      deviceInfo: MOCK_DEVICE_INFO,
      activeApp: MOCK_ACTIVE_APP,
      pendingSignRequest: { hash: 1n },
    });
    const result = send('signer_idle', c, { type: 'DISCONNECT' });
    expect(result.state).toBe('disconnected');
    expect(result.context.transport).toBeNull();
    expect(result.context.deviceInfo).toBeNull();
    expect(result.context.activeApp).toBeNull();
    expect(result.context.pendingSignRequest).toBeNull();
  });

  it('disposed ignores all events', () => {
    const result = send('disposed', ctx(), { type: 'CONNECT' });
    expect(result.state).toBe('disposed');
  });
});

// ─── Error recovery ───────────────────────────────────────────────────────────

describe('error recovery', () => {
  it('RESET from error → disconnected', () => {
    const result = send('error.transport_lost', ctx(), { type: 'RESET' });
    expect(result.state).toBe('disconnected');
    expect(result.context.error).toBeNull();
  });

  it('RETRY from error → last safe state', () => {
    const c = ctx({ lastSafeState: 'signer_idle' });
    const result = send('error.timeout', c, { type: 'RETRY' });
    expect(result.state).toBe('signer_idle');
    expect(result.context.error).toBeNull();
  });

  it('RETRY preserves lastSafeState correctly', () => {
    const c = ctx({ lastSafeState: 'device_ready' });
    const result = send('error.protocol_error', c, { type: 'RETRY' });
    expect(result.state).toBe('device_ready');
  });

  it('lastSafeState is updated on transport disconnect', () => {
    const c = ctx({ lastSafeState: 'disconnected' });
    // signer_idle IS a safe state, so it should be captured
    const result = send('signer_idle', c, { type: 'TRANSPORT_DISCONNECTED' });
    expect(result.context.lastSafeState).toBe('signer_idle');
  });

  it('lastSafeState is NOT updated from non-safe state', () => {
    const c = ctx({ lastSafeState: 'signer_idle' });
    const result = send('confirming', c, { type: 'TRANSPORT_DISCONNECTED' });
    expect(result.context.lastSafeState).toBe('signer_idle');
  });
});

// ─── Mode switching ───────────────────────────────────────────────────────────

describe('mode switching', () => {
  it('disconnected → SWITCH_MODE(installer) → stays disconnected, mode updated', () => {
    const result = send('disconnected', ctx(), {
      type: 'SWITCH_MODE',
      mode: 'installer',
    });
    expect(result.state).toBe('disconnected');
    expect(result.context.mode).toBe('installer');
  });

  it('signer_idle → SWITCH_MODE(installer) → install_idle', () => {
    const result = send('signer_idle', ctx(), {
      type: 'SWITCH_MODE',
      mode: 'installer',
    });
    expect(result.state).toBe('install_idle');
    expect(result.context.mode).toBe('installer');
  });

  it('install_idle → SWITCH_MODE(signer) → signer_idle', () => {
    const c = ctx({ mode: 'installer' });
    const result = send('install_idle', c, {
      type: 'SWITCH_MODE',
      mode: 'signer',
    });
    expect(result.state).toBe('signer_idle');
    expect(result.context.mode).toBe('signer');
  });
});

// ─── Initial context ──────────────────────────────────────────────────────────

describe('createInitialContext', () => {
  it('defaults to signer mode', () => {
    const c = createInitialContext();
    expect(c.mode).toBe('signer');
    expect(c.transport).toBeNull();
    expect(c.lastSafeState).toBe('disconnected');
  });

  it('accepts installer mode', () => {
    const c = createInitialContext('installer');
    expect(c.mode).toBe('installer');
  });
});
