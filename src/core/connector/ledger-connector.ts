/**
 * LedgerHardwareConnector — engine-facing adapter.
 *
 * Implements the HardwareConnector interface consumed by the RAILGUN engine.
 * Follows the WakuConnector pattern: injected into HardwareWallet via
 * setConnector().
 *
 * Responsibilities:
 * - Owns transport lifecycle (connect/disconnect)
 * - Owns RailgunSigner instance
 * - Translates engine sign requests to APDU operations
 * - Enforces app presence + version before signing
 * - Thread-safe: serializes concurrent sign calls via queue
 *
 * Does NOT own UI or state machine — that's the component's job.
 */

import type {
  HardwareConnector,
  HardwareConnectorSignFn,
  HardwareConnectorSignResult,
  LedgerConnectorConfig,
  PublicInputsRailgun,
  RequestApprovalOptions,
} from './types.js';
import type { ClearSignTransactRequest } from '../transport/clear-sign-apdu.js';
import type { HWTransport } from '../transport/types.js';
import { RailgunSigner } from '../signers/railgun-signer.js';
import { getActiveApp, isVersionSatisfied } from '../device/device-manager.js';
import { HWError, HWErrorCode } from '../errors.js';
import { assertExpectedHashMatchesPublicInputs } from '../../validation/public-inputs.js';

const DEFAULT_SIGN_TIMEOUT = 60_000;

/**
 * Create a LedgerHardwareConnector.
 *
 * @param transport - Connected HWTransport instance
 * @param config - Connector configuration
 * @returns HardwareConnector ready for engine injection
 */
export function createLedgerConnector(
  transport: HWTransport,
  config: LedgerConnectorConfig,
): HardwareConnector {
  const signer = new RailgunSigner({
    transport,
    ...(config.account !== undefined ? { account: config.account } : {}),
    ...(config.profile !== undefined ? { profile: config.profile } : {}),
  });
  const signTimeout = config.signTimeout ?? DEFAULT_SIGN_TIMEOUT;

  // Mutex for serializing sign operations
  let signLock: Promise<void> = Promise.resolve();

  /**
   * Verify the RAILGUN app is open and meets minimum version.
   * Called before every sign operation.
   */
  async function ensureAppReady(): Promise<void> {
    const activeApp = await getActiveApp(transport);
    if (activeApp === null) {
      throw new HWError(
        HWErrorCode.APP_OPEN_FAILED,
        `Required app "${config.appName}" is not open on the device`,
      );
    }
    if (activeApp.name !== config.appName) {
      throw new HWError(
        HWErrorCode.APP_OPEN_FAILED,
        `Wrong app open: expected "${config.appName}", got "${activeApp.name}"`,
      );
    }
    if (!isVersionSatisfied(activeApp.version, config.minAppVersion)) {
      throw new HWError(
        HWErrorCode.APP_VERSION_MISMATCH,
        `App version ${activeApp.version} < required ${config.minAppVersion}`,
      );
    }
  }

  /**
   * Wrap a promise with a timeout.
   */
  function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new HWError(HWErrorCode.TRANSPORT_TIMEOUT, `Operation timed out after ${String(ms)}ms`),
        );
      }, ms);
      promise.then(
        (val) => { clearTimeout(timer); resolve(val); },
        (err: unknown) => {
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        },
      );
    });
  }

  /**
   * Serialize sign operations to prevent concurrent APDU sends.
   */
  function serialized<T>(fn: () => Promise<T>): Promise<T> {
    const prev = signLock;
    let release: () => void;
    signLock = new Promise<void>((r) => { release = r; });
    return prev.then(fn).finally(() => { release(); });
  }

  const sign: HardwareConnectorSignFn = (
    expectedHash: bigint,
    publicInputs?: PublicInputsRailgun,
    _subSession?: string,
    clearSign?: ClearSignTransactRequest,
  ): Promise<HardwareConnectorSignResult> => {
    return serialized(async () => {
      if (publicInputs !== undefined) {
        await assertExpectedHashMatchesPublicInputs(expectedHash, publicInputs);
      }
      await ensureAppReady();
      // Toggle: clear-sign the plaintext transact (device reviews it) and return its
      // outputs; otherwise blind-sign the expected hash.
      if (clearSign !== undefined) {
        const result = await withTimeout(signer.signClearSignTransact(clearSign), signTimeout);
        return { ...result.signature, clearSign: { msgHash: result.msgHash, outputs: result.outputs } };
      }
      return withTimeout(signer.sign(expectedHash), signTimeout);
    });
  };

  const requestBatchApproval = (
    _requests: readonly RequestApprovalOptions[],
  ): Promise<boolean> => {
    // Batch approval is handled by the UI component / state machine.
    // The connector just returns true — the state machine gates actual signing.
    return Promise.resolve(true);
  };

  const getPublicKey = async (): Promise<{ readonly x: bigint; readonly y: bigint }> => {
    await ensureAppReady();
    return withTimeout(signer.getPublicKey(), signTimeout);
  };

  const isConnected = (): boolean => {
    return transport.isConnected();
  };

  const disconnect = async (): Promise<void> => {
    await transport.disconnect();
  };

  return {
    type: 'ledger',
    deviceId: `ledger:${config.appName}`,
    sign,
    requestBatchApproval,
    getPublicKey,
    isConnected,
    disconnect,
  };
}
