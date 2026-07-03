/**
 * Root private keys for SCP authentication.
 *
 * These keys are used to establish a Secure Channel with Ledger devices.
 * The device must have the corresponding public key in its trust chain.
 *
 * SECURITY NOTE: These are sideloading root keys, not user wallet keys.
 * They authenticate the installer to the device's bootloader, not user funds.
 * The device will show the corresponding public key for user verification.
 */

import { hexToBytes } from '@noble/hashes/utils.js';
import type { KeyEnvironment } from './types.js';

/**
 * Development root key.
 * Used for test builds and development devices.
 */
const DEV_ROOT_KEY = hexToBytes(
  '330ea33543913e04f41977fa42c20b6471bc6dbca6030dbec62883d2a6b96491',
);

/**
 * Production root key.
 * Used for production app builds distributed to end users.
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ SECURITY — RELEASE BLOCKER                                           │
 * │ This is STILL the development key (identical bytes to DEV_ROOT_KEY). │
 * │ It MUST be replaced with the real production root key before any     │
 * │ production release / package publish. Do not perform 'prod' installs │
 * │ while this placeholder is in place.                                  │
 * └─────────────────────────────────────────────────────────────────────┘
 */
const PROD_ROOT_KEY = hexToBytes(
  '330ea33543913e04f41977fa42c20b6471bc6dbca6030dbec62883d2a6b96491',
);

/**
 * Get the root private key for the given environment.
 */
export function getRootKey(env: KeyEnvironment): Uint8Array {
  switch (env) {
    case 'dev':
      return DEV_ROOT_KEY;
    case 'prod':
      return PROD_ROOT_KEY;
    default:
      throw new Error(`Unknown key environment: ${String(env)}`);
  }
}
