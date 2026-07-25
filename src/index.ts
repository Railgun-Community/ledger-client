/**
 * @railgun-community/ledger-client — Public API
 *
 * Re-exports the types and modules that consuming applications need.
 */

// ─── Core types ───────────────────────────────────────────────────────────────
export type {
  HardwareConnector,
  HardwareConnectorSignFn,
  HardwareConnectorSignResult,
  LedgerConnectorConfig,
  Signature,
  PublicInputsRailgun,
  RequestApprovalOptions,
} from './core/connector/types.js';

export type {
  HWTransport,
  ApduCommand,
  ApduResponse,
  TransportType,
  TransportConfig,
} from './core/transport/types.js';

export { StatusWord } from './core/transport/types.js';

export type {
  DeviceInfo,
  AppInfo,
  ActiveAppInfo,
  AppRequirement,
  DeviceState,
} from './core/device/types.js';

export type {
  SignerType,
  SignResult,
  RailgunSignResult,
  EthSignResult,
  SignRequest,
  RailgunSignRequest,
  EthTxSignRequest,
  EthMessageSignRequest,
  EthTypedDataSignRequest,
} from './core/signers/types.js';

export type {
  AppManifest,
  InstallRequest,
  InstallVerification,
  InstallConfig,
  InstallProgress,
  InstallPhase,
  InstallResult,
  InstallVerificationData,
  OnProgress,
  ScpChannel,
  ScpSession,
} from './core/installer/types.js';

export {
  TRANSIENT_STATUS_WORDS,
  STATUS_HINTS,
  DEFAULT_TARGET_ID,
} from './core/installer/types.js';

// ─── SCP Installer ───────────────────────────────────────────────────────────
export { installApp, verifyInstalledApp } from './core/installer/installer.js';
export { extractAppName, computeCodeHash, computeAppHash, computeCodeId } from './core/installer/apdu-parser.js';
export { tryGetTargetIdFromElf } from './core/installer/elf-parser.js';
export {
  loadBundledInstallArtifact,
  listBundledInstallArtifacts,
  BUNDLED_INSTALL_ARTIFACT_KEYS,
} from './core/installer/bundled-artifacts.js';
export type {
  BundledArtifactTarget,
  BundledInstallArtifact,
} from './core/installer/bundled-artifacts.js';

// ─── Installer key generation + attestation (EXPERIMENTAL) ───────────────────
// The consuming wallet developer generates and injects their own SCP root key;
// no key is bundled. `buildKeyAttestation`/`verifyKeyAttestation` produce and
// check a self-signed proof that the public key the installer portrays is
// validly theirs. API and attestation format may change.
export {
  generateInstallerKeypair,
  buildKeyAttestation,
  verifyKeyAttestation,
  computeInstallerKeyFingerprint,
  KEY_ATTESTATION_SCHEMA,
  KEY_ATTESTATION_VERSION,
  KEY_ATTESTATION_PURPOSE,
  KEY_ATTESTATION_STATUS,
} from './core/installer/attestation.js';
export type {
  InstallerKeypair,
  KeyAttestationV1,
  KeyAttestationArtifact,
  KeyAttestationIdentity,
  KeyAttestationInput,
  KeyAttestationVerifyResult,
} from './core/installer/attestation.js';

// ─── Capability status (experimental surface map) ────────────────────────────
export { CAPABILITY_STATUS } from './core/capabilities.js';
export type { CapabilityStatus } from './core/capabilities.js';

// MachineMode is part of the snapshot contract (LedgerControllerSnapshot.mode). The rest of
// the state-machine types (MachineState/MachineEvent/MachineContext/TransitionResult) are
// internal — consumers drive the flow through the LedgerController snapshot
// (readiness/action/modal), not the raw FSM types.
export type { MachineMode } from './core/state-machine/types.js';

// ─── Errors ───────────────────────────────────────────────────────────────────
export { HWError, HWErrorCode } from './core/errors.js';

// ─── RAILGUN APDU commands ───────────────────────────────────────────────────
// STATUS: FROST/MPC builders (buildInjectSecret, buildGetCommitments,
// buildInjectCommitments1/2, buildPartialSign, buildMpcReset,
// COMMITMENTS_RESPONSE_LENGTH) are UNSUPPORTED — the live RAILGUN app does not
// implement FROST yet. The EIP-7702 builders (RAILGUN_EIP7702_BIP32_PATH,
// buildRailgunEip7702Bip32Path, buildSignEip7702Authorization) are UNDER
// DEVELOPMENT. See CAPABILITY_STATUS.
export type {
  ApduCommandDef,
  ApduSignDef,
  ApduProfile,
  EthereumSignCapability,
  RailgunAppCapabilities,
} from './core/transport/apdu-profile.js';
export { RAILGUN_PROFILE } from './core/transport/apdu-profile.js';
export {
  RAILGUN_CLA,
  KEY_INDEX,
  RAILGUN_BIP32_PATH,
  RAILGUN_EIP7702_BIP32_PATH,
  RailgunAppINS,
  encodeAccountIndex,
  encodeBip32Path,
  buildRailgunEthereumBip32Path,
  buildRailgunEip7702Bip32Path,
  buildGetPublicKey,
  buildSignHash,
  buildGetViewingKey,
  buildGetViewingPublicKey,
  buildGetRailgunAddress,
  buildGetEthereumPublicKey,
  buildSignEip7702Authorization,
  buildSignEthereumTxHash,
  parseEthereumSignatureResponse,
  buildInjectSecret,
  buildGetCommitments,
  buildInjectCommitments1,
  buildInjectCommitments2,
  buildPartialSign,
  buildMpcReset,
  SIGN_RESPONSE_LENGTH,
  PUBLIC_KEY_RESPONSE_LENGTH,
  VIEWING_KEY_RESPONSE_LENGTH,
  VIEWING_PUBLIC_KEY_RESPONSE_LENGTH,
  RAILGUN_ADDRESS_RESPONSE_LENGTH,
  COMMITMENTS_RESPONSE_LENGTH,
} from './core/transport/apdu.js';
export type { RailgunEthereumPathRequest, EthereumSignatureParts } from './core/transport/apdu.js';

// ─── CLEAR_SIGN transact protocol (INS 0x11) — EXPERIMENTAL (firmware 1.6.1) ──
// CLEAR_SIGN transact signing: pure builders + shape validator + the
// RailgunSigner / LedgerController orchestrators (single-tx + dual-tx). The
// device-generated output responses are returned raw; splicing them into the
// on-chain transact calldata (full RAILGUN-engine integration) is not included.
// See CAPABILITY_STATUS.clearSign.
export {
  ClearSignP1,
  CLEAR_SIGN_MAX_MEMO_LEN,
  CLEAR_SIGN_MIN_GAS_PRICE_MAX,
  CLEAR_SIGN_OUTPUT_TYPE_TRANSFER,
  CLEAR_SIGN_OUTPUT_TUPLE_RESPONSE_LENGTH,
  CLEAR_SIGN_TRANSFER_RESPONSE_LENGTH,
  CLEAR_SIGN_UNSHIELD_RESPONSE_LENGTH,
  encodeErc20TokenHash,
  validateClearSignShape,
  buildClearSignInit,
  buildClearSignNullifier,
  buildClearSignBpFields,
  buildClearSignOutBroadcaster,
  buildClearSignOutChange,
  buildClearSignOutTransfer,
  buildClearSignOutUnshield,
  buildClearSignOutput,
  buildClearSignFinalize,
  buildClearSignInitMultiTx,
  decodeClearSignOutput,
} from './core/transport/clear-sign-apdu.js';
export type {
  ClearSignInitRequest,
  ClearSignBpFieldsRequest,
  ClearSignBroadcasterOutput,
  ClearSignChangeOutput,
  ClearSignTransferOutput,
  ClearSignUnshieldOutput,
  ClearSignOutput,
  ClearSignTransactRequest,
  ClearSignOutputResult,
  ClearSignSubTransact,
  ClearSignMultiTransactRequest,
  ClearSignDecodedTuple,
  ClearSignDecodedOutput,
} from './core/transport/clear-sign-apdu.js';

// ─── Device registry ─────────────────────────────────────────────────────────
export {
  RAILGUN_APP,
  ETH_APP,
  APP_REGISTRY,
} from './core/device/app-registry.js';

// ─── Validation ───────────────────────────────────────────────────────────────
export {
  validatePublicInputs,
  validateHash,
  computeRailgunPoseidonHash,
  assertExpectedHashMatchesPublicInputs,
  isInField,
  BABYJUBJUB_ORDER,
} from './validation/public-inputs.js';

export {
  validateApduResponse,
  parseSignResponse,
  parsePublicKeyResponse,
  parseViewingKeyResponse,
  parseViewingPublicKeyResponse,
  parseRailgunAddressResponse,
  parseClearSignFinalize,
  parseClearSignFinalizeMulti,
  parseClearSignOutputResponse,
  extractEchoedHash,
} from './validation/apdu-response.js';

export {
  validateManifest,
  validateBinarySize,
  validateManifestFileSize,
} from './validation/manifest.js';

export {
  validateSignature,
  BABYJUBJUB_SUBGROUP_ORDER,
  BABYJUBJUB_FIELD_PRIME,
} from './validation/signature.js';

// ─── SDK controller contracts ───────────────────────────────────────────────
export type { LedgerModalIntent } from './sdk/controller/modal-intents.js';
export type {
  LedgerControllerReadiness,
  LedgerControllerAction,
  LedgerDeviceSession,
  LedgerApprovalSessionSummary,
  LedgerControllerSnapshot,
} from './sdk/controller/snapshot.js';
export type {
  LedgerConnectOptions,
  LedgerEnsureReadyOptions,
  LedgerBatchApprovalSession,
  LedgerControllerListener,
  LedgerControllerOptions,
  LedgerController,
} from './sdk/controller/types.js';
export { createLedgerController } from './sdk/controller/ledger-controller.js';

// ─── SDK engine contracts ──────────────────────────────────────────────────
// STATUS: the *7702* / RelayAdapt7702 exports below are UNDER DEVELOPMENT
// (see CAPABILITY_STATUS).
export type {
  EngineLedgerSignFn,
  EngineLedgerConnector,
  LegacyEngineLedgerConnector,
} from './sdk/engine/types.js';
export {
  createEngineLedgerConnector,
  createLegacyEngineLedgerConnector,
} from './sdk/engine/create-engine-ledger-connector.js';
export type {
  Railgun7702Signer,
  Railgun7702SignerRequest,
  RailgunRelayAdapt7702HookedSigner,
  RailgunRelayAdapt7702SignerBackend,
  RailgunRelayAdapt7702SignerOptions,
  RailgunRelayAdapt7702SignerProvider,
  RailgunRelayAdapt7702SignerRequest,
  RelayAdapt7702Authorization,
  RelayAdapt7702AuthorizationRequest,
  RelayAdapt7702TypedDataDomain,
  RelayAdapt7702TypedDataField,
  RelayAdapt7702TypedDataTypes,
  RelayAdapt7702TypedDataValue,
} from './sdk/engine/railgun-7702-hooked-signer.js';
export {
  buildRelayAdapt7702Digest,
  buildRelayAdapt7702DomainSeparator,
  buildRelayAdapt7702StructHash,
  createRailgun7702SignerProvider,
  createRailgunRelayAdapt7702HookedSigner,
  createRailgunRelayAdapt7702HookedSignerFromRailgunSigner,
  createRailgunRelayAdapt7702SignerProvider,
  encodeEthereumSignature,
} from './sdk/engine/railgun-7702-hooked-signer.js';

// ─── APDU wire format ─────────────────────────────────────────────────────────
export {
  serializeApdu,
  deserializeApduResponse,
  formatStatusWord,
} from './core/transport/apdu-wire.js';

// ─── Dashboard commands ───────────────────────────────────────────────────────
export {
  buildDashboardGetVersion,
  buildGetAppAndVersion,
  buildOpenApp,
  buildCloseApp,
  buildListApps,
} from './core/transport/dashboard-commands.js';

// ─── Transport factory ───────────────────────────────────────────────────────
export { createTransport } from './core/transport/transport-factory.js';
export { WebHIDTransport } from './core/transport/webhid-transport.js';
export { WebBLETransport } from './core/transport/web-ble-transport.js';

// ─── Device-state recovery ───────────────────────────────────────────────────
export { clearDeviceState } from './core/transport/clear-state.js';
export type {
  ClearStateOutcome,
  ClearStateOptions,
} from './core/transport/clear-state.js';

// ─── Device management ───────────────────────────────────────────────────────
export {
  getDeviceInfo,
  getActiveApp,
  listInstalledApps,
  openApp,
  closeApp,
  isVersionSatisfied,
} from './core/device/device-manager.js';

// ─── Connector ────────────────────────────────────────────────────────────────
export { createLedgerConnector } from './core/connector/ledger-connector.js';

// ─── Signers ──────────────────────────────────────────────────────────────────
export { RailgunSigner } from './core/signers/railgun-signer.js';
export type {
  Eip7702AuthorizationRequest,
  EthereumTxHashSignOptions,
  RailgunEthereumPreloadRequest,
  RailgunEthereumSignerSession,
  RailgunEthereumAddressResult,
  RailgunSignerConfig,
  ClearSignTransactResult,
  ClearSignMultiTransactResult,
} from './core/signers/railgun-signer.js';
export {
  EthSigner,
  RAILGUN_SHIELD_MESSAGE,
  buildEthereumAccountDerivationPath,
} from './core/signers/eth-signer.js';
export type {
  EthSignerConfig,
  HwSignShieldResult,
  ShieldOwnershipMarkerResult,
} from './core/signers/eth-signer.js';
export type { RailgunWalletArtifacts } from './core/wallet-artifacts.js';

// ─── Transport adapter ──────────────────────────────────────────────────────
export { createLedgerTransportAdapter } from './core/transport/ledger-transport-adapter.js';

// ─── State machine ───────────────────────────────────────────────────────────
export { transition, createInitialContext } from './core/state-machine/machine.js';
export {
  isWebHIDAvailable,
  isBLEAvailable,
  hasTransport,
  isAppInstalled,
  isAppVersionSatisfied,
  isCorrectAppOpen,
  hasPendingSign,
  hasPendingBatch,
  isBatchComplete,
  isSafeState,
  isErrorState,
  isTerminalState,
} from './core/state-machine/guards.js';
