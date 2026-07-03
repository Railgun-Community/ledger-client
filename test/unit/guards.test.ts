/**
 * State machine guards tests.
 */

import { describe, it, expect } from 'vitest';
import {
  isWebHIDAvailable,
  hasTransport,
  isAppInstalled,
  isAppVersionSatisfied,
  isCorrectAppOpen,
  hasPendingSign,
  hasPendingBatch,
  isBatchComplete,
  isSafeState,
  isErrorState,
  isTerminalState,
} from '../../src/core/state-machine/guards.js';
import { createInitialContext } from '../../src/core/state-machine/machine.js';
import type { MachineContext } from '../../src/core/state-machine/types.js';
import type { AppRequirement } from '../../src/core/device/types.js';

function ctx(overrides?: Partial<MachineContext>): MachineContext {
  return { ...createInitialContext(), ...overrides };
}

const RAILGUN_REQ: AppRequirement = { name: 'RAILGUN', minVersion: '0.0.1', cla: 0xE1 };

describe('guards', () => {
  describe('isWebHIDAvailable', () => {
    it('returns false in Node (no navigator)', () => {
      expect(isWebHIDAvailable()).toBe(false);
    });
  });

  describe('hasTransport', () => {
    it('returns false for null transport', () => {
      expect(hasTransport(ctx())).toBe(false);
    });

    it('returns true for non-null transport', () => {
      // Minimal mock
      const t = { connect: () => {}, disconnect: () => {}, send: () => {}, isConnected: () => true, onDisconnect: () => {} } as unknown as MachineContext['transport'];
      expect(hasTransport(ctx({ transport: t }))).toBe(true);
    });
  });

  describe('isAppInstalled', () => {
    it('returns true when app is in list', () => {
      const c = ctx({
        installedApps: [
          { name: 'RAILGUN', version: '0.1.0' },
          { name: 'Ethereum', version: '1.12.0' },
        ],
      });
      expect(isAppInstalled(c, RAILGUN_REQ)).toBe(true);
    });

    it('returns false when app is NOT in list', () => {
      const c = ctx({
        installedApps: [{ name: 'Ethereum', version: '1.12.0' }],
      });
      expect(isAppInstalled(c, RAILGUN_REQ)).toBe(false);
    });

    it('returns false for empty installedApps', () => {
      expect(isAppInstalled(ctx(), RAILGUN_REQ)).toBe(false);
    });
  });

  describe('isAppVersionSatisfied', () => {
    it('returns true when version >= minVersion', () => {
      const c = ctx({
        installedApps: [{ name: 'RAILGUN', version: '0.2.0' }],
      });
      expect(isAppVersionSatisfied(c, RAILGUN_REQ)).toBe(true);
    });

    it('returns false when version < minVersion', () => {
      const c = ctx({
        installedApps: [{ name: 'RAILGUN', version: '0.0.0' }],
      });
      expect(isAppVersionSatisfied(c, RAILGUN_REQ)).toBe(false);
    });
  });

  describe('isCorrectAppOpen', () => {
    it('returns true when activeApp matches', () => {
      const c = ctx({ activeApp: { name: 'RAILGUN', version: '0.1.0' } });
      expect(isCorrectAppOpen(c, 'RAILGUN')).toBe(true);
    });

    it('returns false when different app is open', () => {
      const c = ctx({ activeApp: { name: 'Ethereum', version: '1.0.0' } });
      expect(isCorrectAppOpen(c, 'RAILGUN')).toBe(false);
    });

    it('returns false when no app is open', () => {
      expect(isCorrectAppOpen(ctx(), 'RAILGUN')).toBe(false);
    });
  });

  describe('hasPendingSign', () => {
    it('returns true when pendingSignRequest is set', () => {
      const c = ctx({ pendingSignRequest: { hash: 1n } });
      expect(hasPendingSign(c)).toBe(true);
    });

    it('returns false when pendingSignRequest is null', () => {
      expect(hasPendingSign(ctx())).toBe(false);
    });
  });

  describe('hasPendingBatch', () => {
    it('returns true when batch requests exist', () => {
      const c = ctx({ pendingBatchRequests: { requests: [{ hash: 1n }] } });
      expect(hasPendingBatch(c)).toBe(true);
    });

    it('returns false when null', () => {
      expect(hasPendingBatch(ctx())).toBe(false);
    });
  });

  describe('isBatchComplete', () => {
    it('true when batchIndex ≥ requests length', () => {
      const c = ctx({
        pendingBatchRequests: { requests: [{ hash: 1n }, { hash: 2n }] },
        batchIndex: 2,
      });
      expect(isBatchComplete(c)).toBe(true);
    });

    it('false when more items remain', () => {
      const c = ctx({
        pendingBatchRequests: { requests: [{ hash: 1n }, { hash: 2n }] },
        batchIndex: 1,
      });
      expect(isBatchComplete(c)).toBe(false);
    });

    it('false when no batch requests (null)', () => {
      expect(isBatchComplete(ctx())).toBe(false);
    });
  });

  describe('isSafeState', () => {
    it.each([
      'disconnected',
      'device_ready',
      'signer_idle',
      'install_idle',
    ] as const)('%s is safe', (state) => {
      expect(isSafeState(state)).toBe(true);
    });

    it.each([
      'connecting',
      'confirming',
      'batch_signing_n',
      'error.transport_lost',
    ] as const)('%s is NOT safe', (state) => {
      expect(isSafeState(state)).toBe(false);
    });
  });

  describe('isErrorState', () => {
    it.each([
      'error.transport_lost',
      'error.protocol_error',
      'error.timeout',
      'error.user_rejected',
      'error.app_error',
    ] as const)('%s is error', (state) => {
      expect(isErrorState(state)).toBe(true);
    });

    it('signer_idle is NOT error', () => {
      expect(isErrorState('signer_idle')).toBe(false);
    });
  });

  describe('isTerminalState', () => {
    it('disposed is terminal', () => {
      expect(isTerminalState('disposed')).toBe(true);
    });

    it('disconnected is NOT terminal', () => {
      expect(isTerminalState('disconnected')).toBe(false);
    });
  });
});
