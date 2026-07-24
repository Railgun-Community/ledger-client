import type {
  CommonConnectorBase,
  HardwareConnectorSignFn,
  RequestApprovalOptions,
} from '../../core/connector/types.js';
import type { Assert, Equals, Resolve } from '../../core/internal/type-assert.js';
import type { EthSignResult } from '../../core/signers/types.js';
import type { HwSignShieldResult, ShieldOwnershipMarkerResult } from '../../core/signers/eth-signer.js';
import type { LedgerBatchApprovalSession } from '../controller/types.js';
import type { ClearSignMultiTransactRequest } from '../../core/transport/clear-sign-apdu.js';
import type { ClearSignMultiTransactResult } from '../../core/signers/railgun-signer.js';

export type EngineLedgerSignFn = HardwareConnectorSignFn;

/**
 * Shared shape of the sdk engine connectors: the common connector base plus the
 * ETH/shield signing methods. Internal — not re-exported from the barrel; the two
 * public connector types below differ only in their requestBatchApproval return.
 */
export type EngineLedgerConnectorBase = CommonConnectorBase & {
  hwSignShield: (derivationIndex: number) => Promise<HwSignShieldResult>;
  signShieldOwnershipMarker?: (
    derivationIndex: number,
  ) => Promise<ShieldOwnershipMarkerResult>;
  signEthTransaction: (
    rawTxHex: string,
    derivationIndex: number,
  ) => Promise<EthSignResult>;
};

export type EngineLedgerConnector = EngineLedgerConnectorBase & {
  requestBatchApproval: (
    requests: readonly RequestApprovalOptions[],
  ) => Promise<LedgerBatchApprovalSession>;
};

export type LegacyEngineLedgerConnector = EngineLedgerConnectorBase & {
  requestBatchApproval: (
    requests: readonly RequestApprovalOptions[],
  ) => Promise<boolean>;
};

/* ── compile-time structural-identity locks (internal; not exported) ───────────
 * Freeze the RESOLVED public shapes so a future refactor cannot silently change
 * what consumers depend on. Enforced by `yarn typecheck`. Equals/Assert/Resolve
 * come from ../../core/internal/type-assert.js. */

type EngineLedgerConnector_Reference = {
  readonly type: 'ledger';
  readonly deviceId: string;
  sign: EngineLedgerSignFn;
  signClearMultiTransact: (
    request: ClearSignMultiTransactRequest,
  ) => Promise<ClearSignMultiTransactResult>;
  hwSignShield: (derivationIndex: number) => Promise<HwSignShieldResult>;
  signShieldOwnershipMarker?: (
    derivationIndex: number,
  ) => Promise<ShieldOwnershipMarkerResult>;
  signEthTransaction: (
    rawTxHex: string,
    derivationIndex: number,
  ) => Promise<EthSignResult>;
  requestBatchApproval: (
    requests: readonly RequestApprovalOptions[],
  ) => Promise<LedgerBatchApprovalSession>;
  getPublicKey: () => Promise<{ readonly x: bigint; readonly y: bigint }>;
  isConnected: () => boolean;
  disconnect: () => Promise<void>;
};
type _LockEngineLedgerConnector = Assert<
  Equals<Resolve<EngineLedgerConnector>, EngineLedgerConnector_Reference>
>;

type LegacyEngineLedgerConnector_Reference = {
  readonly type: 'ledger';
  readonly deviceId: string;
  sign: EngineLedgerSignFn;
  signClearMultiTransact: (
    request: ClearSignMultiTransactRequest,
  ) => Promise<ClearSignMultiTransactResult>;
  hwSignShield: (derivationIndex: number) => Promise<HwSignShieldResult>;
  signShieldOwnershipMarker?: (
    derivationIndex: number,
  ) => Promise<ShieldOwnershipMarkerResult>;
  signEthTransaction: (
    rawTxHex: string,
    derivationIndex: number,
  ) => Promise<EthSignResult>;
  requestBatchApproval: (
    requests: readonly RequestApprovalOptions[],
  ) => Promise<boolean>;
  getPublicKey: () => Promise<{ readonly x: bigint; readonly y: bigint }>;
  isConnected: () => boolean;
  disconnect: () => Promise<void>;
};
type _LockLegacyEngineLedgerConnector = Assert<
  Equals<Resolve<LegacyEngineLedgerConnector>, LegacyEngineLedgerConnector_Reference>
>;

/* Premise this refactor relies on: the sdk sign fn is structurally the core one. */
type _LockEngineLedgerSignFn = Assert<
  Equals<EngineLedgerSignFn, HardwareConnectorSignFn>
>;