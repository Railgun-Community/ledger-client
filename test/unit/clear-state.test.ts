/**
 * Tests for clearDeviceState — device-state recovery sequence.
 *
 * The function never throws: every outcome is a discriminated union.
 * These tests exercise each branch using MockTransport.
 */

import { describe, it, expect } from 'vitest';
import { MockTransport } from '../integration/mock-transport.js';
import {
  clearDeviceState,
  type ClearStateOutcome,
} from '../../src/core/transport/clear-state.js';
import { StatusWord } from '../../src/core/transport/types.js';
import { RailgunAppINS, RAILGUN_CLA } from '../../src/core/transport/apdu.js';

function successResponse(data: Uint8Array) {
  return { data, statusWord: StatusWord.SUCCESS };
}

function errorResponse(sw: number) {
  return { data: new Uint8Array(0), statusWord: sw };
}

/** Build a synthetic GET_APP_AND_VERSION response. */
function buildAppVersionResponse(name: string, version: string): Uint8Array {
  const nameBytes = new TextEncoder().encode(name);
  const versionBytes = new TextEncoder().encode(version);
  const buf = new Uint8Array(1 + 1 + nameBytes.length + 1 + versionBytes.length);
  let offset = 0;
  buf[offset++] = 0x01;
  buf[offset++] = nameBytes.length;
  buf.set(nameBytes, offset);
  offset += nameBytes.length;
  buf[offset++] = versionBytes.length;
  buf.set(versionBytes, offset);
  return buf;
}

/** Empty GET_APP_AND_VERSION response → dashboard. */
const dashboardActiveResponse = successResponse(new Uint8Array(0));

async function connected(): Promise<MockTransport> {
  const t = new MockTransport();
  await t.connect();
  return t;
}

describe('clearDeviceState', () => {
  it('returns transport_lost when transport is not connected', async () => {
    const transport = new MockTransport();
    const outcome = await clearDeviceState(transport);
    expect(outcome).toEqual<ClearStateOutcome>({ kind: 'transport_lost' });
    expect(transport.sentCommands).toHaveLength(0);
  });

  it('returns ready with active app when an app is open and no expectedApp', async () => {
    const transport = await connected();
    transport.enqueueResponse(successResponse(buildAppVersionResponse('RAILGUN', '1.6.0')));

    const outcome = await clearDeviceState(transport);

    expect(outcome.kind).toBe('ready');
    if (outcome.kind === 'ready') {
      expect(outcome.activeApp).toEqual({ name: 'RAILGUN', version: '1.6.0' });
    }
    // resetMpc default-off → no MPC_RESET, no second probe.
    expect(transport.sentCommands).toHaveLength(1);
  });

  it('returns ready with null activeApp when dashboard is active and no expectedApp', async () => {
    const transport = await connected();
    transport.enqueueResponse(dashboardActiveResponse);

    const outcome = await clearDeviceState(transport);

    expect(outcome.kind).toBe('ready');
    if (outcome.kind === 'ready') {
      expect(outcome.activeApp).toBeNull();
    }
  });

  it('returns needs_unlock on the first probe when device is locked', async () => {
    const transport = await connected();
    transport.enqueueResponse(errorResponse(StatusWord.LOCKED_DEVICE));

    const outcome = await clearDeviceState(transport, { expectedApp: 'RAILGUN' });

    expect(outcome).toEqual<ClearStateOutcome>({ kind: 'needs_unlock' });
    // Only the first probe should have been sent — no MPC_RESET, no second probe.
    expect(transport.sentCommands).toHaveLength(1);
  });

  it('returns needs_app_open when expectedApp differs from active app', async () => {
    const transport = await connected();
    transport.enqueueResponse(successResponse(buildAppVersionResponse('Ethereum', '1.10.4')));

    const outcome = await clearDeviceState(transport, { expectedApp: 'RAILGUN' });

    expect(outcome).toEqual<ClearStateOutcome>({
      kind: 'needs_app_open',
      expectedApp: 'RAILGUN',
    });
  });

  it('returns needs_app_open when dashboard is active and expectedApp is set', async () => {
    const transport = await connected();
    transport.enqueueResponse(dashboardActiveResponse);

    const outcome = await clearDeviceState(transport, { expectedApp: 'RAILGUN' });

    expect(outcome).toEqual<ClearStateOutcome>({
      kind: 'needs_app_open',
      expectedApp: 'RAILGUN',
    });
  });

  it('returns transport_lost when the first probe throws a transport error', async () => {
    const transport = await connected();
    // No queued response → MockTransport returns INTERNAL_ERROR; force disconnect instead.
    await transport.disconnect();

    const outcome = await clearDeviceState(transport);

    expect(outcome).toEqual<ClearStateOutcome>({ kind: 'transport_lost' });
  });

  describe('with resetMpc enabled', () => {
    it('sends MPC_RESET only when RAILGUN app is active', async () => {
      const transport = await connected();
      // First probe: RAILGUN active
      transport.enqueueResponse(successResponse(buildAppVersionResponse('RAILGUN', '1.6.0')));
      // MPC_RESET response (SUCCESS — for a hypothetical FROST-enabled app)
      transport.enqueueResponse(successResponse(new Uint8Array(0)));
      // Second probe: still RAILGUN active
      transport.enqueueResponse(successResponse(buildAppVersionResponse('RAILGUN', '1.6.0')));

      const outcome = await clearDeviceState(transport, { resetMpc: true });

      expect(outcome.kind).toBe('ready');
      // 3 commands: probe, MPC_RESET, probe
      expect(transport.sentCommands).toHaveLength(3);
      const mpcReset = transport.sentCommands[1];
      expect(mpcReset?.cla).toBe(RAILGUN_CLA);
      expect(mpcReset?.ins).toBe(RailgunAppINS.MPC_RESET);
    });

    it('skips MPC_RESET when a non-RAILGUN app is active', async () => {
      const transport = await connected();
      transport.enqueueResponse(successResponse(buildAppVersionResponse('Ethereum', '1.10.4')));

      const outcome = await clearDeviceState(transport, { resetMpc: true });

      expect(outcome.kind).toBe('ready');
      // 1 command: the initial probe. MPC_RESET is skipped, so we reuse it.
      expect(transport.sentCommands).toHaveLength(1);
      const mpcResetSent = transport.sentCommands.some(
        (cmd) => cmd.ins === RailgunAppINS.MPC_RESET,
      );
      expect(mpcResetSent).toBe(false);
    });

    it('ignores INS_NOT_SUPPORTED from MPC_RESET (current live app behavior)', async () => {
      const transport = await connected();
      transport.enqueueResponse(successResponse(buildAppVersionResponse('RAILGUN', '1.6.0')));
      // Live RAILGUN app today returns INS_NOT_SUPPORTED for 0x1f.
      transport.enqueueResponse(errorResponse(StatusWord.INS_NOT_SUPPORTED));
      transport.enqueueResponse(successResponse(buildAppVersionResponse('RAILGUN', '1.6.0')));

      const outcome = await clearDeviceState(transport, {
        resetMpc: true,
        expectedApp: 'RAILGUN',
      });

      expect(outcome.kind).toBe('ready');
    });

    it('returns needs_unlock if MPC_RESET locks the device mid-sequence', async () => {
      const transport = await connected();
      transport.enqueueResponse(successResponse(buildAppVersionResponse('RAILGUN', '1.6.0')));
      // MPC_RESET returns locked (SW only — handled as best-effort, ignored).
      transport.enqueueResponse(errorResponse(StatusWord.LOCKED_DEVICE));
      // Second probe sees the locked state.
      transport.enqueueResponse(errorResponse(StatusWord.LOCKED_DEVICE));

      const outcome = await clearDeviceState(transport, { resetMpc: true });

      expect(outcome).toEqual<ClearStateOutcome>({ kind: 'needs_unlock' });
    });
  });

  it('is idempotent — calling twice with identical state returns the same outcome', async () => {
    const transport = await connected();
    transport.enqueueResponse(successResponse(buildAppVersionResponse('RAILGUN', '1.6.0')));
    transport.enqueueResponse(successResponse(buildAppVersionResponse('RAILGUN', '1.6.0')));

    const first = await clearDeviceState(transport, { expectedApp: 'RAILGUN' });
    const second = await clearDeviceState(transport, { expectedApp: 'RAILGUN' });

    expect(first).toEqual(second);
  });
});