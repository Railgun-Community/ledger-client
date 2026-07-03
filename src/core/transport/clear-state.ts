/**
 * Device state recovery.
 *
 * After any APDU error the device may be in an ambiguous state:
 *   - locked (returns 0x5515 to every command),
 *   - mid-FROST (commitments injected but not consumed),
 *   - the wrong app open,
 *   - dashboard active when an app is expected.
 *
 * `clearDeviceState` runs a small, tolerant recovery sequence that
 * resolves to a discriminated outcome the caller (UI/controller) can
 * act on. The function never throws — every step swallows its own
 * APDU/transport errors and continues to the next probe.
 *
 * The function only sends commands that are safe to issue from any
 * state: GET_APP_AND_VERSION (BOLOS, idempotent) and MPC_RESET
 * (RAILGUN app, idempotent). It does NOT close/open apps — those are
 * the caller's decision based on the returned outcome.
 */

import type { HWTransport } from './types.js';
import type { ActiveAppInfo } from '../device/types.js';
import { HWError, HWErrorCode } from '../errors.js';
import { getActiveApp } from '../device/device-manager.js';
import { buildMpcReset, RAILGUN_PROFILE } from './apdu.js';

export type ClearStateOutcome =
  | { readonly kind: 'ready'; readonly activeApp: ActiveAppInfo | null }
  | { readonly kind: 'needs_unlock' }
  | { readonly kind: 'needs_app_open'; readonly expectedApp?: string }
  | { readonly kind: 'app_not_installed'; readonly appName: string }
  | { readonly kind: 'transport_lost' }
  | { readonly kind: 'unrecoverable'; readonly error: HWError };

export type ClearStateOptions = {
  /** If set, verify this app is the active app after clearing. */
  readonly expectedApp?: string;
  /**
   * Send MPC_RESET as part of the sequence. Default false — the live
   * RAILGUN BOLOS app does not implement FROST/MPC yet, so this would
   * be a no-op returning 0x6d00 (INS_NOT_SUPPORTED). Flip to true
   * once FROST signing lands on-device. Only sent when the active app
   * is RAILGUN.
   */
  readonly resetMpc?: boolean;
};

type ProbeResult =
  | { readonly kind: 'ok'; readonly activeApp: ActiveAppInfo | null }
  | { readonly kind: 'locked' }
  | { readonly kind: 'transport_lost' }
  | { readonly kind: 'error'; readonly error: HWError };

async function probeActiveApp(transport: HWTransport): Promise<ProbeResult> {
  try {
    const activeApp = await getActiveApp(transport);
    return { kind: 'ok', activeApp };
  } catch (error) {
    if (error instanceof HWError) {
      if (
        error.code === HWErrorCode.TRANSPORT_DISCONNECTED
        || error.code === HWErrorCode.TRANSPORT_TIMEOUT
      ) {
        return { kind: 'transport_lost' };
      }
      const message = error.message.toLowerCase();
      if (message.includes('locked')) {
        return { kind: 'locked' };
      }
      return { kind: 'error', error };
    }
    const message = error instanceof Error ? error.message : String(error);
    const lowered = message.toLowerCase();
    if (
      lowered.includes('disconnect')
      || lowered.includes('disconnected')
      || lowered.includes('closed')
    ) {
      return { kind: 'transport_lost' };
    }
    if (lowered.includes('locked')) {
      return { kind: 'locked' };
    }
    return {
      kind: 'error',
      error: new HWError(HWErrorCode.APDU_STATUS_ERROR, message, error),
    };
  }
}

async function trySendMpcReset(transport: HWTransport): Promise<'sent' | 'transport_lost'> {
  try {
    const response = await transport.send(buildMpcReset());
    // Any non-SUCCESS SW is fine — MPC_RESET is best-effort cleanup.
    void response;
    return 'sent';
  } catch (error) {
    if (error instanceof HWError) {
      if (
        error.code === HWErrorCode.TRANSPORT_DISCONNECTED
        || error.code === HWErrorCode.TRANSPORT_TIMEOUT
      ) {
        return 'transport_lost';
      }
    }
    const message = error instanceof Error ? error.message.toLowerCase() : '';
    if (
      message.includes('disconnect')
      || message.includes('disconnected')
      || message.includes('closed')
    ) {
      return 'transport_lost';
    }
    return 'sent';
  }
}

/**
 * Run the device-state recovery sequence.
 *
 * Sequence:
 *   1. Probe GET_APP_AND_VERSION.
 *      - locked → return `needs_unlock`
 *      - transport throw → return `transport_lost`
 *   2. If `resetMpc` (default) and the RAILGUN app appears active,
 *      send MPC_RESET. Errors from this step are ignored unless the
 *      transport itself fails.
 *   3. Re-probe GET_APP_AND_VERSION and reconcile against `expectedApp`.
 *
 * Never throws — always resolves to a `ClearStateOutcome`.
 */
export async function clearDeviceState(
  transport: HWTransport,
  options: ClearStateOptions = {},
): Promise<ClearStateOutcome> {
  if (!transport.isConnected()) {
    return { kind: 'transport_lost' };
  }

  const expectedApp = options.expectedApp;
  const resetMpc = options.resetMpc ?? false;

  const firstProbe = await probeActiveApp(transport);
  if (firstProbe.kind === 'locked') return { kind: 'needs_unlock' };
  if (firstProbe.kind === 'transport_lost') return { kind: 'transport_lost' };
  if (firstProbe.kind === 'error') return { kind: 'unrecoverable', error: firstProbe.error };

  let activeApp = firstProbe.activeApp;
  const willSendMpcReset =
    resetMpc
    && firstProbe.activeApp !== null
    && firstProbe.activeApp.name === RAILGUN_PROFILE.name;

  if (willSendMpcReset) {
    const reset = await trySendMpcReset(transport);
    if (reset === 'transport_lost') return { kind: 'transport_lost' };

    const secondProbe = await probeActiveApp(transport);
    if (secondProbe.kind === 'locked') return { kind: 'needs_unlock' };
    if (secondProbe.kind === 'transport_lost') return { kind: 'transport_lost' };
    if (secondProbe.kind === 'error') return { kind: 'unrecoverable', error: secondProbe.error };
    activeApp = secondProbe.activeApp;
  }

  if (expectedApp !== undefined) {
    if (activeApp === null || activeApp.name !== expectedApp) {
      return { kind: 'needs_app_open', expectedApp };
    }
  }

  return { kind: 'ready', activeApp };
}