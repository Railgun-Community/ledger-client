import type {
  PublicInputsRailgun,
  RequestApprovalOptions,
  Signature,
} from '../../core/connector/types.js';
import type { EthSignResult } from '../../core/signers/types.js';
import type { HwSignShieldResult, ShieldOwnershipMarkerResult } from '../../core/signers/eth-signer.js';
import type { LedgerBatchApprovalSession } from '../controller/types.js';

export type EngineLedgerSignFn = (
  expectedHash: bigint,
  publicInputs?: PublicInputsRailgun,
  subSession?: string,
) => Promise<Signature>;

export type EngineLedgerConnector = {
  readonly type: 'ledger';
  readonly deviceId: string;
  sign: EngineLedgerSignFn;
  hwSignShield: (derivationIndex: number) => Promise<HwSignShieldResult>;
  signShieldOwnershipMarker?: (derivationIndex: number) => Promise<ShieldOwnershipMarkerResult>;
  signEthTransaction: (rawTxHex: string, derivationIndex: number) => Promise<EthSignResult>;
  requestBatchApproval: (
    requests: readonly RequestApprovalOptions[],
  ) => Promise<LedgerBatchApprovalSession>;
  getPublicKey: () => Promise<{ readonly x: bigint; readonly y: bigint }>;
  isConnected: () => boolean;
  disconnect: () => Promise<void>;
};

export type LegacyEngineLedgerConnector = {
  readonly type: 'ledger';
  readonly deviceId: string;
  sign: EngineLedgerSignFn;
  hwSignShield: (derivationIndex: number) => Promise<HwSignShieldResult>;
  signShieldOwnershipMarker?: (derivationIndex: number) => Promise<ShieldOwnershipMarkerResult>;
  signEthTransaction: (rawTxHex: string, derivationIndex: number) => Promise<EthSignResult>;
  requestBatchApproval: (
    requests: readonly RequestApprovalOptions[],
  ) => Promise<boolean>;
  getPublicKey: () => Promise<{ readonly x: bigint; readonly y: bigint }>;
  isConnected: () => boolean;
  disconnect: () => Promise<void>;
};