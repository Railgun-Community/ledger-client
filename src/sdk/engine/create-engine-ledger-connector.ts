import type { RequestApprovalOptions, PublicInputsRailgun, HardwareConnectorSignResult } from '../../core/connector/types.js';
import { HWError, HWErrorCode } from '../../core/errors.js';
import type { LedgerController } from '../controller/types.js';
import type {
  EngineLedgerConnector,
  EngineLedgerConnectorBase,
  LegacyEngineLedgerConnector,
} from './types.js';

/**
 * The engine signing path requires publicInputs so the RAILGUN hash is bound to
 * the transaction it represents — never a blind, hash-only signature.
 */
function requirePublicInputs(
  publicInputs: PublicInputsRailgun | undefined,
): asserts publicInputs is PublicInputsRailgun {
  if (publicInputs === undefined) {
    throw new HWError(
      HWErrorCode.VALIDATION_PUBLIC_INPUTS,
      'RAILGUN engine signing requires publicInputs so the hash is bound to the transaction it represents.',
    );
  }
}

/**
 * Shared value-typed methods for both engine connectors. Deliberately excludes
 * `type` and `deviceId`: `deviceId` is a live getter each factory declares inline,
 * and spreading it here would flatten it to a construction-time snapshot.
 */
function createEngineConnectorMethods(
  controller: LedgerController,
): Omit<EngineLedgerConnectorBase, 'type' | 'deviceId'> {
  return {
    sign: (expectedHash, publicInputs, subSession, clearSign): Promise<HardwareConnectorSignResult> => {
      requirePublicInputs(publicInputs);
      // Toggle: when a plaintext transact is supplied, clear-sign it (device reviews
      // recipients/tokens/amounts) and return its outputs; otherwise blind-sign.
      if (clearSign !== undefined) {
        return controller
          .signClearSignTransact(clearSign)
          .then((result) => ({
            ...result.signature,
            clearSign: { msgHash: result.msgHash, outputs: result.outputs },
          }));
      }
      return controller.sign(expectedHash, publicInputs, subSession);
    },
    hwSignShield: (derivationIndex) =>
      controller.hwSignShield(derivationIndex),
    ...(controller.signShieldOwnershipMarker === undefined
      ? {}
      : {
          signShieldOwnershipMarker: (derivationIndex: number) =>
            controller.signShieldOwnershipMarker!(derivationIndex),
        }),
    signEthTransaction: (rawTxHex, derivationIndex) =>
      controller.signEthTransaction(rawTxHex, derivationIndex),
    getPublicKey: () => controller.getPublicKey(),
    isConnected: () => controller.getSnapshot().deviceSession !== null,
    disconnect: () => controller.disconnect(),
  };
}

export function createEngineLedgerConnector(
  controller: LedgerController,
): EngineLedgerConnector {
  return {
    type: 'ledger',
    get deviceId(): string {
      return controller.getSnapshot().deviceSession?.deviceSessionId ?? 'ledger:disconnected';
    },
    ...createEngineConnectorMethods(controller),
    requestBatchApproval: (requests) => controller.requestBatchApproval(requests),
  };
}

export function createLegacyEngineLedgerConnector(
  controller: LedgerController,
): LegacyEngineLedgerConnector {
  return {
    type: 'ledger',
    get deviceId(): string {
      return controller.getSnapshot().deviceSession?.deviceSessionId ?? 'ledger:disconnected';
    },
    ...createEngineConnectorMethods(controller),
    requestBatchApproval: async (requests: readonly RequestApprovalOptions[]): Promise<boolean> => {
      const result = await controller.requestBatchApproval(requests);
      if (!result.approved) {
        throw new HWError(HWErrorCode.BATCH_REJECTED, 'Batch approval was rejected.');
      }
      return true;
    },
  };
}