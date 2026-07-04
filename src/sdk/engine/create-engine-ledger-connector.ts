import type { RequestApprovalOptions, PublicInputsRailgun, Signature } from '../../core/connector/types.js';
import { HWError, HWErrorCode } from '../../core/errors.js';
import type { LedgerController } from '../controller/types.js';
import type {
  EngineLedgerConnector,
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

export function createEngineLedgerConnector(
  controller: LedgerController,
): EngineLedgerConnector {
  return {
    type: 'ledger',
    get deviceId(): string {
      return controller.getSnapshot().deviceSession?.deviceSessionId ?? 'ledger:disconnected';
    },
    sign: (expectedHash, publicInputs, subSession): Promise<Signature> => {
      requirePublicInputs(publicInputs);
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
    requestBatchApproval: (requests) => controller.requestBatchApproval(requests),
    getPublicKey: () => controller.getPublicKey(),
    isConnected: () => controller.getSnapshot().deviceSession !== null,
    disconnect: () => controller.disconnect(),
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
    sign: (expectedHash, publicInputs, subSession): Promise<Signature> => {
      requirePublicInputs(publicInputs);
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
    requestBatchApproval: async (requests: readonly RequestApprovalOptions[]): Promise<boolean> => {
      const result = await controller.requestBatchApproval(requests);
      if (!result.approved) {
        throw new HWError(HWErrorCode.BATCH_REJECTED, 'Batch approval was rejected.');
      }
      return true;
    },
    getPublicKey: () => controller.getPublicKey(),
    isConnected: () => controller.getSnapshot().deviceSession !== null,
    disconnect: () => controller.disconnect(),
  };
}