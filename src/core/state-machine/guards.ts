/**
 * Transition guard predicates.
 *
 * Pure boolean functions that determine whether a state transition is allowed.
 * Guards receive the current context and the event, return true/false.
 * No side effects.
 */

import type { MachineContext } from './types.js';
import type { AppRequirement } from '../device/types.js';
import { isVersionSatisfied } from '../device/device-manager.js';

/**
 * Check if WebHID is available in the current environment.
 */
export function isWebHIDAvailable(): boolean {
  return (
    typeof globalThis.navigator !== 'undefined' &&
    'hid' in globalThis.navigator
  );
}

/**
 * Check if transport is connected.
 */
export function hasTransport(ctx: MachineContext): boolean {
  return ctx.transport !== null && ctx.transport.isConnected();
}

/**
 * Check if a required app is installed in the device's app list.
 */
export function isAppInstalled(
  ctx: MachineContext,
  requirement: AppRequirement,
): boolean {
  return ctx.installedApps.some(
    (app) => app.name === requirement.name,
  );
}

/**
 * Check if a required app meets the minimum version requirement.
 */
export function isAppVersionSatisfied(
  ctx: MachineContext,
  requirement: AppRequirement,
): boolean {
  const app = ctx.installedApps.find((a) => a.name === requirement.name);
  if (app === undefined) return false;
  return isVersionSatisfied(app.version, requirement.minVersion);
}

/**
 * Check if the active app matches the required app name.
 */
export function isCorrectAppOpen(
  ctx: MachineContext,
  appName: string,
): boolean {
  return ctx.activeApp !== null && ctx.activeApp.name === appName;
}

/**
 * Check if there's a pending sign request.
 */
export function hasPendingSign(ctx: MachineContext): boolean {
  return ctx.pendingSignRequest !== null;
}

/**
 * Check if there are pending batch requests.
 */
export function hasPendingBatch(ctx: MachineContext): boolean {
  return ctx.pendingBatchRequests !== null;
}

/**
 * Check if all batch signatures are collected.
 */
export function isBatchComplete(ctx: MachineContext): boolean {
  if (ctx.pendingBatchRequests === null) return false;
  return ctx.batchIndex >= ctx.pendingBatchRequests.requests.length;
}

/**
 * Check if the machine is in a "safe" state that we can return to on retry.
 */
export function isSafeState(state: string): boolean {
  const safeStates = new Set([
    'disconnected',
    'device_ready',
    'signer_idle',
    'install_idle',
  ]);
  return safeStates.has(state);
}

/**
 * Check if the state is an error state.
 */
export function isErrorState(state: string): boolean {
  return state.startsWith('error.');
}

/**
 * Check if the state is a terminal state.
 */
export function isTerminalState(state: string): boolean {
  return state === 'disposed';
}
