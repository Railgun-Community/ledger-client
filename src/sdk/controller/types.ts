import type { HWTransport, TransportType } from '../../core/transport/types.js';
import type { ClearStateOutcome } from '../../core/transport/clear-state.js';
import type {
  HardwareConnector,
  PublicInputsRailgun,
  RequestApprovalOptions,
  Signature,
} from '../../core/connector/types.js';
import type { EthSignResult } from '../../core/signers/types.js';
import type { HwSignShieldResult, ShieldOwnershipMarkerResult } from '../../core/signers/eth-signer.js';
import type { EthereumSignatureParts } from '../../core/transport/apdu.js';
import type {
  RailgunEthereumPreloadRequest,
  RailgunEthereumSignerSession,
  ClearSignTransactResult,
  ClearSignMultiTransactResult,
} from '../../core/signers/railgun-signer.js';
import type {
  ClearSignTransactRequest,
  ClearSignMultiTransactRequest,
} from '../../core/transport/clear-sign-apdu.js';
import type { RailgunWalletArtifacts } from '../../core/wallet-artifacts.js';
import type { AppRequirement } from '../../core/device/types.js';
import type { HWError } from '../../core/errors.js';
import type { LedgerControllerSnapshot } from './snapshot.js';

export type LedgerConnectOptions = {
  readonly transportType?: TransportType;
};

export type LedgerEnsureReadyOptions = {
  readonly requiredApp?: AppRequirement;
};

export type LedgerBatchApprovalSession = {
  readonly approved: boolean;
  readonly subSession: string;
  readonly approvalDigest: string;
  readonly deviceSessionId: string;
  readonly createdAt: number;
  readonly expiresAt?: number;
};

export type LedgerControllerListener = (
  snapshot: LedgerControllerSnapshot,
) => void;

export type LedgerControllerOptions = {
  readonly requiredApps?: readonly AppRequirement[];
  readonly defaultTransportType?: TransportType;
  readonly approvalTimeoutMs?: number;
  readonly transportFactory?: (transportType: TransportType) => HWTransport;
  readonly onError?: (error: HWError) => void;
  readonly onDisconnect?: () => void;
};

export interface LedgerController {
  connect(options?: LedgerConnectOptions): Promise<void>;
  disconnect(): Promise<void>;
  ensureReady(options?: LedgerEnsureReadyOptions): Promise<void>;
  getPublicKey(): Promise<{ readonly x: bigint; readonly y: bigint }>;
  getWalletArtifacts(): Promise<RailgunWalletArtifacts>;
  hwSignShield(derivationIndex: number): Promise<HwSignShieldResult>;
  signShieldOwnershipMarker?: (derivationIndex: number) => Promise<ShieldOwnershipMarkerResult>;
  /**
   * Read the Ethereum EOA address at the given BIP-44 index from the device.
   *
   * `display` defaults to `false` — silent derivation, no on-device prompt.
   * Pass `true` to have the device show the address for visual confirmation
   * (used for high-stakes flows like funding a new account).
   */
  getEthAddress(
    derivationIndex: number,
    display?: boolean,
  ): Promise<{ readonly address: string; readonly publicKey: string }>;
  getEthAddressAtPath(
    derivationPath: string,
    display?: boolean,
  ): Promise<{ readonly address: string; readonly publicKey: string }>;
  signEthTransaction(rawTxHex: string, derivationIndex: number): Promise<EthSignResult>;
  signEthMessage(message: string | Uint8Array, derivationIndex: number): Promise<EthSignResult>;
  signEthTypedData(
    payload: { readonly domainSeparatorHex: string; readonly hashStructMessageHex: string },
    derivationIndex: number,
  ): Promise<EthSignResult>;
  signEthTypedDataAtPath(
    payload: { readonly domainSeparatorHex: string; readonly hashStructMessageHex: string },
    derivationPath: string,
  ): Promise<EthSignResult>;
  prepareRailgunEthereumSigner(
    request: RailgunEthereumPreloadRequest,
  ): Promise<RailgunEthereumSignerSession>;
  signRailgunEthereumHash(
    hashHex: string,
    session: RailgunEthereumSignerSession,
    display?: boolean,
  ): Promise<EthereumSignatureParts>;
  signRailgunEip7702Authorization(
    request: {
      readonly session: RailgunEthereumSignerSession;
      readonly contractAddressHex: string;
      readonly nonce: bigint;
    },
  ): Promise<EthereumSignatureParts>;
  /** Clear-sign a RAILGUN transact (INS 0x11) — the device reviews the recipients/tokens/amounts. Experimental. */
  signClearSignTransact(
    request: ClearSignTransactRequest,
  ): Promise<ClearSignTransactResult>;
  /** Clear-sign a multi-tx transact (txToken != feeToken → one signature per tx). Experimental. */
  signClearSignMultiTransact(
    request: ClearSignMultiTransactRequest,
  ): Promise<ClearSignMultiTransactResult>;
  sign(
    expectedHash: bigint,
    publicInputs?: PublicInputsRailgun,
    subSession?: string,
  ): Promise<Signature>;
  requestBatchApproval(
    requests: readonly RequestApprovalOptions[],
  ): Promise<LedgerBatchApprovalSession>;
  approveCurrentAction(): boolean;
  rejectCurrentAction(reason?: Error): boolean;
  getConnector(): HardwareConnector | null;
  getSnapshot(): LedgerControllerSnapshot;
  clearError(): void;
  /**
   * Run the device recovery sequence (see `clearDeviceState` in
   * core/transport/clear-state.ts). Never throws — resolves to a
   * `ClearStateOutcome` the UI can branch on (ready, needs_unlock,
   * needs_app_open, transport_lost, unrecoverable).
   */
  clearDeviceState(): Promise<ClearStateOutcome>;
  openApp(appName: string): Promise<void>;
  closeApp(): Promise<void>;
  installApp(
    config: Omit<import('../../core/installer/types.js').InstallConfig, never>,
    onProgress?: (p: import('../../core/installer/types.js').InstallProgress) => void,
  ): Promise<void>;
  subscribe(listener: LedgerControllerListener): () => void;
  dispose(): Promise<void>;
}