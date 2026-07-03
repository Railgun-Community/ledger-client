import type { RequestApprovalOptions } from '../../core/connector/types.js';
import { HWError, HWErrorCode } from '../../core/errors.js';
import type { LedgerController } from '../controller/types.js';
import type {
  EngineLedgerConnector,
  LegacyEngineLedgerConnector,
} from './types.js';

export function createEngineLedgerConnector(
  controller: LedgerController,
): EngineLedgerConnector {
  return {
    type: 'ledger',
    get deviceId(): string {
      return controller.getSnapshot().deviceSession?.deviceSessionId ?? 'ledger:disconnected';
    },
    sign: (expectedHash, publicInputs, subSession) =>
      controller.sign(expectedHash, publicInputs, subSession),
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
    sign: (expectedHash, publicInputs, subSession) =>
      controller.sign(expectedHash, publicInputs, subSession),
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