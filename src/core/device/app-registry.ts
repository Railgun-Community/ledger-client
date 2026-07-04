/**
 * Known app definitions — CLA bytes, minimum versions, display names.
 *
 * This registry is used by the device manager and state machine to
 * identify and validate installed applications.
 */

import type { AppRequirement } from './types.js';

/** RAILGUN custom app requirement. */
export const RAILGUN_APP: AppRequirement = {
  name: 'RAILGUN',
  minVersion: '0.0.1',
  cla: 0xe0,
};

/** Standard Ethereum app requirement. */
export const ETH_APP: AppRequirement = {
  name: 'Ethereum',
  minVersion: '1.12.0',
  cla: 0xe0,
};

/** All known app requirements indexed by name. */
export const APP_REGISTRY: ReadonlyMap<string, AppRequirement> = new Map([
  [RAILGUN_APP.name, RAILGUN_APP],
  [ETH_APP.name, ETH_APP],
]);
