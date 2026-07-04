import { createLedgerConnector } from '../../core/connector/ledger-connector.js';
import type {
  HardwareConnector,
  PublicInputsRailgun,
  RequestApprovalOptions,
  Signature,
} from '../../core/connector/types.js';
import { installApp } from '../../core/installer/installer.js';
import type { InstallConfig, InstallProgress } from '../../core/installer/types.js';
import { ETH_APP, RAILGUN_APP } from '../../core/device/app-registry.js';
import {
  getActiveApp,
  getDeviceInfo,
  isVersionSatisfied,
  openApp as deviceOpenApp,
  closeApp as deviceCloseApp,
} from '../../core/device/device-manager.js';
import { EthSigner } from '../../core/signers/eth-signer.js';
import type { EthSignResult } from '../../core/signers/types.js';
import {
  buildEthereumAccountDerivationPath,
  type HwSignShieldResult,
  type ShieldOwnershipMarkerResult,
} from '../../core/signers/eth-signer.js';
import { RailgunSigner } from '../../core/signers/railgun-signer.js';
import type { EthereumSignatureParts } from '../../core/transport/apdu.js';
import { classifyDeviceError } from '../../core/transport/status-words.js';
import type {
  RailgunEthereumPreloadRequest,
  RailgunEthereumSignerSession,
} from '../../core/signers/railgun-signer.js';
import type {
  ActiveAppInfo,
  AppRequirement,
  DeviceInfo,
} from '../../core/device/types.js';
import { HWError, HWErrorCode } from '../../core/errors.js';
import type { RailgunWalletArtifacts } from '../../core/wallet-artifacts.js';
import { assertExpectedHashMatchesPublicInputs } from '../../validation/public-inputs.js';
import {
  createInitialContext,
  transition,
} from '../../core/state-machine/machine.js';
import type {
  MachineContext,
  MachineEvent,
  MachineState,
} from '../../core/state-machine/types.js';
import { createTransport } from '../../core/transport/transport-factory.js';
import type { HWTransport, TransportType } from '../../core/transport/types.js';
import {
  clearDeviceState as runClearDeviceState,
  type ClearStateOutcome,
} from '../../core/transport/clear-state.js';
import type { LedgerModalIntent } from './modal-intents.js';
import type {
  LedgerControllerSnapshot,
  LedgerControllerAction,
  LedgerControllerReadiness,
  LedgerApprovalSessionSummary,
} from './snapshot.js';
import type {
  LedgerBatchApprovalSession,
  LedgerController,
  LedgerControllerListener,
  LedgerControllerOptions,
  LedgerEnsureReadyOptions,
} from './types.js';

type PendingAction =
  | {
      readonly kind: 'sign';
      readonly hash: bigint;
      readonly publicInputs?: PublicInputsRailgun;
      resolve: () => void;
      reject: (error: Error) => void;
    }
  | {
      readonly kind: 'batch';
      readonly requests: readonly RequestApprovalOptions[];
      readonly approvalDigest: string;
      readonly session: LedgerBatchApprovalSession;
      resolve: (session: LedgerBatchApprovalSession) => void;
      reject: (error: Error) => void;
    };

export function createLedgerController(
  options: LedgerControllerOptions = {},
): LedgerController {
  const requiredApps = options.requiredApps ?? [RAILGUN_APP];
  const defaultTransportType = options.defaultTransportType ?? 'webhid';
  const approvalTimeoutMs = options.approvalTimeoutMs ?? 5 * 60_000;
  const transportFactory = options.transportFactory
    ?? ((transportType: TransportType): HWTransport =>
      createTransport({ type: transportType }));

  let state: MachineState = 'disconnected';
  let context: MachineContext = createInitialContext('signer');
  let transport: HWTransport | null = null;
  let connector: HardwareConnector | null = null;
  let connectorRequirement: AppRequirement | null = null;
  let openingAppRequirement: AppRequirement | null = null;
  let deviceSessionId: string | null = null;
  let disposed = false;
  let activeApprovalSession: LedgerBatchApprovalSession | null = null;
  let pendingAction: PendingAction | null = null;
  let lastError: HWError | null = null;
  let transportDisconnecting: Promise<void> | null = null;
  const listeners = new Set<LedgerControllerListener>();
  let queue: Promise<unknown> = Promise.resolve();

  function emit(): void {
    const snapshot = getSnapshot();
    for (const listener of listeners) {
      listener(snapshot);
    }
  }

  function createDeferred<T>(): {
    readonly promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (error: Error) => void;
  } {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(fn, fn);
    queue = run.then(() => undefined, () => undefined);
    return run;
  }

  function settleAutoState(): void {
    while (
      state === 'signed'
      || state === 'sign_rejected'
      || state === 'eth_complete'
      || state === 'batch_complete'
      || state === 'batch_rejected'
    ) {
      send({ type: 'RETRY' });
    }
  }

  function disconnectTransport(
    activeTransport: HWTransport,
    disconnectOptions: { readonly swallowErrors?: boolean } = {},
  ): Promise<void> {
    const pendingDisconnect = activeTransport.disconnect().catch((error: unknown) => {
      if (disconnectOptions.swallowErrors === true) {
        return;
      }
      throw error;
    }).finally(() => {
      if (transportDisconnecting === pendingDisconnect) {
        transportDisconnecting = null;
      }
    });
    transportDisconnecting = pendingDisconnect;
    return pendingDisconnect;
  }

  function send(event: MachineEvent): void {
    const result = transition(state, context, event);
    state = result.state;
    context = result.context;

    if (event.type === 'TRANSPORT_ERROR') {
      lastError = event.error;
    } else if (event.type === 'TRANSPORT_DISCONNECTED') {
      lastError = new HWError(
        HWErrorCode.TRANSPORT_DISCONNECTED,
        'Ledger transport disconnected.',
      );
    } else if (!state.startsWith('error.')) {
      lastError = context.error;
    }

    if (state === 'signer_idle') {
      pendingAction = null;
      if (context.pendingBatchRequests === null) {
        activeApprovalSession = null;
      }
    }

    emit();
  }

  function invalidateSessions(): void {
    connector = null;
    connectorRequirement = null;
    openingAppRequirement = null;
    deviceSessionId = null;
    activeApprovalSession = null;
    if (pendingAction !== null) {
      pendingAction.reject(
        new HWError(HWErrorCode.TRANSPORT_DISCONNECTED, 'Controller session invalidated.'),
      );
      pendingAction = null;
    }
  }

  function cancelPendingAction(reason: HWError): void {
    if (pendingAction === null) {
      return;
    }

    const currentPendingAction = pendingAction;

    if (currentPendingAction.kind === 'sign') {
      send({ type: 'REJECT_SIGN' });
      currentPendingAction.reject(reason);
      pendingAction = null;
      settleAutoState();
      return;
    }

    send({ type: 'REJECT_BATCH' });
    currentPendingAction.reject(reason);
    pendingAction = null;
    activeApprovalSession = null;
    settleAutoState();
  }

  function randomId(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return `ledger-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function hashBigint(value: bigint): string {
    return value.toString(16).padStart(64, '0');
  }

  function computeApprovalDigest(
    requests: readonly RequestApprovalOptions[],
  ): string {
    const normalized = requests.map((request) => ({
      id: request.id,
      description: request.description,
      hash: hashBigint(request.hash),
      publicInputs: {
        merkleRoot: hashBigint(request.publicInputs.merkleRoot),
        boundParamsHash: hashBigint(request.publicInputs.boundParamsHash),
        nullifiers: request.publicInputs.nullifiers.map(hashBigint),
        commitmentsOut: request.publicInputs.commitmentsOut.map(hashBigint),
      },
    }));
    return JSON.stringify(normalized);
  }

  /**
   * Digest of a single sign item — its hash + public inputs. Used to verify a
   * per-item sign request against the approved batch set (independent of the
   * request id/description, which the sign call itself does not carry).
   */
  function computeItemDigest(hash: bigint, publicInputs: PublicInputsRailgun): string {
    return JSON.stringify({
      hash: hashBigint(hash),
      publicInputs: {
        merkleRoot: hashBigint(publicInputs.merkleRoot),
        boundParamsHash: hashBigint(publicInputs.boundParamsHash),
        nullifiers: publicInputs.nullifiers.map(hashBigint),
        commitmentsOut: publicInputs.commitmentsOut.map(hashBigint),
      },
    });
  }

  function getRequiredApp(
    override?: AppRequirement,
  ): AppRequirement {
    return override ?? requiredApps[0] ?? RAILGUN_APP;
  }

  function ensureNotDisposed(): void {
    if (disposed) {
      throw new HWError(HWErrorCode.TRANSPORT_DISCONNECTED, 'Controller is disposed.');
    }
  }

  function buildConnector(requirement: AppRequirement): void {
    if (transport === null) {
      throw new HWError(HWErrorCode.TRANSPORT_DISCONNECTED, 'Transport not connected.');
    }
    connectorRequirement = requirement;
    connector = createLedgerConnector(transport, {
      appName: requirement.name,
      minAppVersion: requirement.minVersion,
      derivationPath: "m/44'/9075'/0'/0/0",
    });
  }

  function setActiveRequirement(requirement: AppRequirement): void {
    connectorRequirement = requirement;
  }

  function normalizeRawTransactionHex(rawTxHex: string): string {
    if (typeof rawTxHex !== 'string') {
      throw new HWError(HWErrorCode.VALIDATION_HASH, 'Raw Ethereum transaction hex must be a string.');
    }
    const trimmed = rawTxHex.trim();
    const normalized = trimmed.startsWith('0x') ? trimmed.slice(2) : trimmed;
    if (normalized.length === 0) {
      throw new HWError(HWErrorCode.VALIDATION_HASH, 'Raw Ethereum transaction hex is required.');
    }
    if (normalized.length % 2 !== 0 || /[^0-9a-f]/i.test(normalized)) {
      throw new HWError(HWErrorCode.VALIDATION_HASH, 'Raw Ethereum transaction hex must be an even-length hex string.');
    }
    return normalized.toLowerCase();
  }

  function normalizeHash32Hex(hashHex: string): Uint8Array {
    if (typeof hashHex !== 'string') {
      throw new HWError(HWErrorCode.VALIDATION_HASH, 'Ethereum hash must be a string.');
    }
    const normalized = hashHex.trim().replace(/^0x/i, '');
    if (normalized.length !== 64 || /[^0-9a-f]/i.test(normalized)) {
      throw new HWError(HWErrorCode.VALIDATION_HASH, 'Ethereum hash must be exactly 32 bytes of hex.');
    }
    const bytes = new Uint8Array(32);
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Number.parseInt(normalized.slice(index * 2, index * 2 + 2), 16);
    }
    return bytes;
  }

  function normalizeAddressHex(addressHex: string): Uint8Array {
    if (typeof addressHex !== 'string') {
      throw new HWError(HWErrorCode.VALIDATION_HASH, 'Contract address must be a string.');
    }
    const normalized = addressHex.trim().replace(/^0x/i, '');
    if (normalized.length !== 40 || /[^0-9a-f]/i.test(normalized)) {
      throw new HWError(HWErrorCode.VALIDATION_HASH, 'Contract address must be exactly 20 bytes of hex.');
    }
    const bytes = new Uint8Array(20);
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Number.parseInt(normalized.slice(index * 2, index * 2 + 2), 16);
    }
    return bytes;
  }

  function normalizeEthereumDerivationPath(derivationPath: string): string {
    if (typeof derivationPath !== 'string') {
      throw new HWError(HWErrorCode.VALIDATION_DERIVATION_INDEX, 'Ethereum derivation path must be a string.');
    }
    const normalized = derivationPath.trim();
    if (!normalized.startsWith('m/')) {
      throw new HWError(HWErrorCode.VALIDATION_DERIVATION_INDEX, 'Ethereum derivation path must start with m/.');
    }
    const components = normalized.slice(2).split('/');
    if (components.length === 0 || components.length > 10) {
      throw new HWError(HWErrorCode.VALIDATION_DERIVATION_INDEX, 'Ethereum derivation path must contain 1 to 10 components.');
    }
    for (const component of components) {
      const match = /^(\d+)('?|h|H)$/.exec(component);
      if (match === null) {
        throw new HWError(HWErrorCode.VALIDATION_DERIVATION_INDEX, `Invalid Ethereum derivation path component: ${component}.`);
      }
      const value = Number.parseInt(match[1]!, 10);
      if (!Number.isSafeInteger(value) || value < 0 || value > 0x7fff_ffff) {
        throw new HWError(HWErrorCode.VALIDATION_DERIVATION_INDEX, `Invalid Ethereum derivation path component: ${component}.`);
      }
    }
    return normalized.replace(/h|H/g, "'");
  }

  function normalizeAppOpenError(error: unknown, appName: string): HWError {
    if (error instanceof HWError && error.code === HWErrorCode.APP_NOT_INSTALLED) {
      return error;
    }
    const classified = classifyDeviceError(error);
    if (classified !== null) {
      return classified;
    }
    if (error instanceof HWError) {
      return error;
    }
    const message = error instanceof Error ? error.message : `Failed to open app "${appName}".`;
    return new HWError(HWErrorCode.APP_OPEN_FAILED, message, error);
  }

  function enterAppOpenError(error: HWError): never {
    openingAppRequirement = null;
    lastError = error;
    if (error.code === HWErrorCode.SIGN_REJECTED_DEVICE) {
      send({ type: 'DEVICE_REJECTED' });
      throw error;
    }
    if (error.code === HWErrorCode.APP_NOT_INSTALLED) {
      send({ type: 'APP_MISSING', error });
      throw error;
    }
    if (error.code === HWErrorCode.TRANSPORT_TIMEOUT) {
      send({ type: 'TIMEOUT' });
      throw error;
    }
    if (error.code === HWErrorCode.TRANSPORT_DISCONNECTED) {
      send({ type: 'TRANSPORT_DISCONNECTED' });
      throw error;
    }
    if (error.code === HWErrorCode.TRANSPORT_CONNECTION_FAILED) {
      send({ type: 'TRANSPORT_ERROR', error });
      throw error;
    }
    send({ type: 'APP_OPEN_FAILED' });
    throw error;
  }

  function beginEthSigning(): void {
    send({ type: 'ETH_SIGN_REQUEST' });
  }

  function completeEthSigning(): void {
    send({ type: 'ETH_SIGN_COMPLETE' });
    settleAutoState();
  }

  function normalizeEthOperationError(error: unknown, fallbackMessage: string): HWError {
    if (error instanceof HWError) {
      return error;
    }
    const classified = classifyDeviceError(error);
    if (classified !== null) {
      return classified;
    }
    const message = error instanceof Error ? error.message : fallbackMessage;
    return new HWError(HWErrorCode.APDU_STATUS_ERROR, message, error);
  }

  function failEthSigning(error: HWError): never {
    lastError = error;
    if (error.code === HWErrorCode.SIGN_REJECTED_DEVICE || error.code === HWErrorCode.APDU_REJECTED) {
      send({ type: 'DEVICE_REJECTED', error });
      settleAutoState();
      throw error;
    }
    if (error.code === HWErrorCode.TRANSPORT_TIMEOUT) {
      send({ type: 'TIMEOUT' });
      throw error;
    }
    if (error.code === HWErrorCode.TRANSPORT_DISCONNECTED) {
      send({ type: 'TRANSPORT_DISCONNECTED' });
      throw error;
    }
    send({ type: 'TRANSPORT_ERROR', error });
    throw error;
  }

  async function readVerifiedActiveApp(expectedAppName: string): Promise<ActiveAppInfo> {
    if (transport === null) {
      throw new HWError(HWErrorCode.TRANSPORT_DISCONNECTED, 'Transport not connected.');
    }

    let activeApp: ActiveAppInfo | null;
    try {
      activeApp = await getActiveApp(transport);
    } catch (error) {
      return enterAppOpenError(normalizeAppOpenError(error, expectedAppName));
    }

    if (activeApp === null || activeApp.name !== expectedAppName) {
      return enterAppOpenError(new HWError(
        HWErrorCode.APP_OPEN_FAILED,
        `Failed to open app "${expectedAppName}".`,
      ));
    }

    return activeApp;
  }

  async function ensureStandardAppReady(requirement: AppRequirement): Promise<void> {
    await connectTransport(defaultTransportType);

    if (transport === null) {
      throw new HWError(HWErrorCode.TRANSPORT_DISCONNECTED, 'Transport not connected.');
    }

    setActiveRequirement(requirement);

    const currentApp = await getActiveApp(transport);
    if (currentApp !== null && currentApp.name === requirement.name) {
      if (!isVersionSatisfied(currentApp.version, requirement.minVersion)) {
        send({ type: 'APP_OUTDATED', appInfo: currentApp });
        throw new HWError(
          HWErrorCode.APP_VERSION_MISMATCH,
          `App version ${currentApp.version} < required ${requirement.minVersion}`,
        );
      }

      connector = null;
      send({ type: 'APP_OPENED', appInfo: currentApp });
      return;
    }

    connector = null;

    if (currentApp !== null) {
      await deviceCloseApp(transport);
      send({ type: 'APP_CLOSED' });
    }

    const deviceInfo: DeviceInfo = await getDeviceInfo(transport);
    context = { ...context, deviceInfo };
    send({ type: 'OPEN_APP_REQUEST' });

    try {
      await deviceOpenApp(transport, requirement.name);
    } catch (error) {
      return enterAppOpenError(normalizeAppOpenError(error, requirement.name));
    }

    const readyApp = await readVerifiedActiveApp(requirement.name);

    if (!isVersionSatisfied(readyApp.version, requirement.minVersion)) {
      send({ type: 'APP_OUTDATED', appInfo: readyApp });
      throw new HWError(
        HWErrorCode.APP_VERSION_MISMATCH,
        `App version ${readyApp.version} < required ${requirement.minVersion}`,
      );
    }

    send({ type: 'APP_OPENED', appInfo: readyApp });
  }

  async function connectTransport(transportType: TransportType): Promise<void> {
    if (transportDisconnecting !== null) {
      await transportDisconnecting;
    }

    if (transport !== null && transport.isConnected()) {
      return;
    }

    send({ type: 'CONNECT' });
    const nextTransport = transportFactory(transportType);
    transport = nextTransport;
    context = { ...context, transport: nextTransport };

    nextTransport.onDisconnect(() => {
      if (transport !== nextTransport) {
        return;
      }
      invalidateSessions();
      transport = null;
      context = { ...context, transport: null, activeApp: null };
      send({ type: 'TRANSPORT_DISCONNECTED' });
      options.onDisconnect?.();
    });

    try {
      await nextTransport.connect();
      deviceSessionId = randomId();
      send({ type: 'TRANSPORT_CONNECTED' });
    } catch (error) {
      const hwError = error instanceof HWError
        ? error
        : new HWError(
            HWErrorCode.TRANSPORT_CONNECTION_FAILED,
            error instanceof Error ? error.message : 'Failed to connect Ledger transport.',
            error,
          );
      send({ type: 'TRANSPORT_ERROR', error: hwError });
      options.onError?.(hwError);
      throw hwError;
    }
  }

  async function ensureReadyInternal(
    ensureOptions: LedgerEnsureReadyOptions = {},
  ): Promise<void> {
    ensureNotDisposed();
    const requirement = getRequiredApp(ensureOptions.requiredApp);
    await connectTransport(defaultTransportType);

    if (transport === null) {
      throw new HWError(HWErrorCode.TRANSPORT_DISCONNECTED, 'Transport not connected.');
    }

    // Step 1: Check what is currently active on the device.
    // GET_APP_AND_VERSION works regardless of whether an app is open.
    const currentApp = await getActiveApp(transport);

    if (currentApp !== null && currentApp.name === requirement.name) {
      // Fast path: the required app is already open. GET_VERSION (dashboard
      // command) would fail here, so skip straight to the app-open outcome.
      if (!isVersionSatisfied(currentApp.version, requirement.minVersion)) {
        send({ type: 'APP_OUTDATED', appInfo: currentApp });
        throw new HWError(
          HWErrorCode.APP_VERSION_MISMATCH,
          `App version ${currentApp.version} < required ${requirement.minVersion}`,
        );
      }

      buildConnector(requirement);
      send({ type: 'APP_OPENED', appInfo: currentApp });
      return;
    }

    if (currentApp !== null) {
      await deviceCloseApp(transport);
      send({ type: 'APP_CLOSED' });
    }

    // Step 2: Dashboard is active — safe to query device firmware info.
    const deviceInfo: DeviceInfo = await getDeviceInfo(transport);
    send({ type: 'DEVICE_INFO_RECEIVED', info: deviceInfo });

    // Step 3: Try to open the required app directly.
    // BOLOS returns 0x6807 (APP_NOT_FOUND) if the app is not installed,
    // which device-manager maps to HWErrorCode.APP_NOT_INSTALLED.
    send({ type: 'OPEN_APP_REQUEST' });

    try {
      await deviceOpenApp(transport, requirement.name);
    } catch (error) {
      return enterAppOpenError(normalizeAppOpenError(error, requirement.name));
    }

    // Step 4: Confirm the app opened and check its version.
    const readyApp = await readVerifiedActiveApp(requirement.name);

    if (!isVersionSatisfied(readyApp.version, requirement.minVersion)) {
      send({ type: 'APP_OUTDATED', appInfo: readyApp });
      throw new HWError(
        HWErrorCode.APP_VERSION_MISMATCH,
        `App version ${readyApp.version} < required ${requirement.minVersion}`,
      );
    }

    buildConnector(requirement);
    send({ type: 'APP_OPENED', appInfo: readyApp });
  }

  function mapReadiness(currentState: MachineState): LedgerControllerReadiness {
    if (currentState.startsWith('error.')) return 'error';
    switch (currentState) {
      case 'disconnected':
        return 'disconnected';
      case 'connecting':
      case 'requesting_permission':
        return 'connecting';
      case 'querying_device':
        return 'querying_device';
      case 'device_ready':
        return 'device_ready';
      case 'app_check':
      case 'app_found':
      case 'app_ready':
        return 'app_check';
      case 'app_missing':
        return 'app_missing';
      case 'app_outdated':
        return 'app_outdated';
      case 'opening_app':
        return 'opening_app';
      case 'signer_idle':
      case 'reviewing':
      case 'confirming':
      case 'eth_reviewing':
      case 'eth_confirming':
      case 'eth_complete':
      case 'signed':
      case 'sign_rejected':
      case 'batch_reviewing':
      case 'batch_signing_n':
      case 'batch_complete':
      case 'batch_rejected':
        return 'ready';
      default:
        return 'error';
    }
  }

  function mapAction(currentState: MachineState): LedgerControllerAction {
    switch (currentState) {
      case 'reviewing':
        return 'reviewing_sign';
      case 'batch_reviewing':
        return 'reviewing_batch';
      case 'confirming':
      case 'eth_confirming':
        return 'awaiting_device_confirmation';
      case 'signed':
      case 'eth_complete':
        return 'complete';
      case 'sign_rejected':
      case 'batch_rejected':
        return 'rejected';
      case 'batch_signing_n':
        return 'batch_signing';
      case 'error.user_rejected':
      case 'error.protocol_error':
      case 'error.timeout':
      case 'error.transport_lost':
      case 'error.app_error':
        return 'recoverable_error';
      default:
        return 'idle';
    }
  }

  function deriveModalIntent(): LedgerModalIntent {
    const requirement = openingAppRequirement ?? connectorRequirement ?? requiredApps[0] ?? null;

    if (state === 'disconnected') {
      return { kind: 'connect_hardware' };
    }
    if (state === 'connecting' || state === 'requesting_permission') {
      return { kind: 'request_browser_permission' };
    }
    if (state === 'opening_app' && requirement !== null) {
      return {
        kind: 'open_required_app',
        requiredApp: requirement,
        activeApp: context.activeApp,
      };
    }
    if (state === 'app_missing' && requirement !== null) {
      return { kind: 'app_missing', requiredApp: requirement };
    }
    if (state === 'app_outdated' && requirement !== null && context.activeApp !== null) {
      return {
        kind: 'app_outdated',
        requiredApp: requirement,
        activeApp: context.activeApp,
      };
    }
    if (pendingAction?.kind === 'sign' && state === 'reviewing') {
      return {
        kind: 'review_sign',
        hash: pendingAction.hash,
        ...(pendingAction.publicInputs !== undefined
          ? { publicInputs: pendingAction.publicInputs }
          : {}),
      };
    }
    if (pendingAction?.kind === 'batch' && state === 'batch_reviewing') {
      return {
        kind: 'review_batch',
        requests: pendingAction.requests,
        approvalDigest: pendingAction.approvalDigest,
      };
    }
    if (state === 'confirming') {
      return {
        kind: 'signing_progress',
        step: 'awaiting_device',
        ...(pendingAction?.kind === 'sign'
          ? { hash: pendingAction.hash }
          : {}),
      };
    }
    if (state === 'eth_confirming') {
      return {
        kind: 'signing_progress',
        step: 'awaiting_device',
      };
    }
    if (state === 'batch_signing_n') {
      const total = context.pendingBatchRequests?.requests.length;
      return {
        kind: 'signing_progress',
        step: 'signing',
        currentIndex: context.batchIndex + 1,
        ...(total !== undefined ? { total } : {}),
      };
    }
    if (state === 'error.transport_lost') {
      return { kind: 'transport_disconnected', ...(lastError !== null ? { error: lastError } : {}) };
    }
    if (state.startsWith('error.') && lastError !== null) {
      return { kind: 'recoverable_error', error: lastError, canRetry: true };
    }
    return { kind: 'none' };
  }

  function getApprovalSummary(): LedgerApprovalSessionSummary | null {
    if (activeApprovalSession === null) {
      return null;
    }
    const total = context.pendingBatchRequests?.requests.length;
    const remainingApprovals = total === undefined
      ? undefined
      : Math.max(total - context.batchIndex, 0);
    return {
      subSession: activeApprovalSession.subSession,
      approvalDigest: activeApprovalSession.approvalDigest,
      createdAt: activeApprovalSession.createdAt,
      ...(activeApprovalSession.expiresAt !== undefined
        ? { expiresAt: activeApprovalSession.expiresAt }
        : {}),
      ...(remainingApprovals !== undefined ? { remainingApprovals } : {}),
    };
  }

  function getSnapshot(): LedgerControllerSnapshot {
    return {
      mode: context.mode,
      machineState: state,
      readiness: mapReadiness(state),
      action: mapAction(state),
      isBusy: state !== 'signer_idle' && state !== 'disconnected',
      connectorAvailable: connector !== null,
      requiredApp: openingAppRequirement ?? connectorRequirement ?? requiredApps[0] ?? null,
      deviceSession: deviceSessionId === null
        ? null
        : {
            deviceSessionId,
            deviceInfo: context.deviceInfo,
            activeApp: context.activeApp,
            installedApps: context.installedApps,
          },
      approvalSession: getApprovalSummary(),
      modal: deriveModalIntent(),
      error: lastError,
    };
  }

  async function signInternal(
    expectedHash: bigint,
    publicInputs?: PublicInputsRailgun,
    subSession?: string,
  ): Promise<Signature> {
    ensureNotDisposed();

    if (publicInputs !== undefined) {
      await assertExpectedHashMatchesPublicInputs(expectedHash, publicInputs);
    }

    // Only run full device init if connector hasn't been established yet.
    // When already connected, the connector's own ensureAppReady() (CLA 0xB0)
    // verifies the app is still open. Re-running ensureReadyInternal() would
    // send dashboard APDUs (CLA 0xE0) that collide with the RAILGUN app.
    if (connector === null) {
      await ensureReadyInternal();
    }
    if (connector === null) {
      throw new HWError(HWErrorCode.APP_OPEN_FAILED, 'Connector is not ready.');
    }

    if (subSession !== undefined) {
      if (activeApprovalSession === null || activeApprovalSession.subSession !== subSession) {
        throw new HWError(HWErrorCode.BATCH_REJECTED, 'Invalid or expired batch approval session.');
      }
      if (
        activeApprovalSession.expiresAt !== undefined
        && Date.now() > activeApprovalSession.expiresAt
      ) {
        activeApprovalSession = null;
        throw new HWError(HWErrorCode.BATCH_REJECTED, 'Batch approval session expired.');
      }
      // Bind the signature to the REVIEWED batch: verify this exact (hash,
      // publicInputs) item was part of the approved set — not merely that a valid
      // session token was presented. A post-approval item swap is rejected here.
      if (publicInputs === undefined) {
        throw new HWError(
          HWErrorCode.BATCH_REJECTED,
          'Batch signing requires publicInputs to verify the item against the approved set.',
        );
      }
      const approvedRequests = context.pendingBatchRequests?.requests ?? [];
      const itemDigest = computeItemDigest(expectedHash, publicInputs);
      const isApproved = approvedRequests.some(
        (request) => computeItemDigest(request.hash, request.publicInputs) === itemDigest,
      );
      if (!isApproved) {
        throw new HWError(
          HWErrorCode.BATCH_REJECTED,
          'Signing request was not part of the approved batch.',
        );
      }
    }

    send({ type: 'SIGN_REQUEST', hash: expectedHash, ...(publicInputs !== undefined ? { publicInputs } : {}) });

    const approval = createDeferred<undefined>();
    pendingAction = {
      kind: 'sign',
      hash: expectedHash,
      ...(publicInputs !== undefined ? { publicInputs } : {}),
      resolve: (): void => { approval.resolve(undefined); },
      reject: approval.reject,
    };
    emit();
    await approval.promise;

    try {
      const signature = await connector.sign(expectedHash, publicInputs, subSession);
      send({ type: 'SIGN_COMPLETE', signature });

      if (subSession !== undefined && context.pendingBatchRequests !== null) {
        const nextIndex = context.batchIndex;
        const total = context.pendingBatchRequests.requests.length;
        if (nextIndex >= total) {
          activeApprovalSession = null;
        }
      }

      settleAutoState();
      return signature;
    } catch (error) {
      const hwError = error instanceof HWError
        ? error
        : new HWError(
            HWErrorCode.SIGN_INVALID_RESPONSE,
            error instanceof Error ? error.message : 'Sign failed.',
            error,
          );
      if (hwError.code === HWErrorCode.APDU_REJECTED) {
        send({ type: 'DEVICE_REJECTED' });
      } else {
        send({ type: 'TRANSPORT_ERROR', error: hwError });
      }
      settleAutoState();
      throw hwError;
    }
  }

  async function signShieldOwnershipMarkerInternal(
    derivationIndex: number,
    variant: 'legacy' | 'modern',
  ): Promise<ShieldOwnershipMarkerResult> {
    ensureNotDisposed();
    buildEthereumAccountDerivationPath(derivationIndex);
    await ensureStandardAppReady(ETH_APP);
    if (transport === null) {
      throw new HWError(HWErrorCode.TRANSPORT_DISCONNECTED, 'Transport not connected.');
    }
    const ethSigner = new EthSigner({ transport });
    beginEthSigning();
    try {
      const result = variant === 'legacy'
        ? await ethSigner.hwSignShield(derivationIndex)
        : await ethSigner.signShieldOwnershipMarker(derivationIndex);
      completeEthSigning();
      return result;
    } catch (error) {
      return failEthSigning(
        normalizeEthOperationError(error, 'Shield ownership marker signing failed.'),
      );
    }
  }

  return {
    connect: (connectOptions = {}): Promise<void> => enqueue(async () => {
      ensureNotDisposed();
      await connectTransport(connectOptions.transportType ?? defaultTransportType);
    }),

    disconnect: (): Promise<void> => {
      cancelPendingAction(
        new HWError(HWErrorCode.TRANSPORT_DISCONNECTED, 'Controller session invalidated.'),
      );

      return enqueue(async () => {
      const activeTransport = transport;
      let disconnectError: unknown;
      transport = null;
      try {
        if (activeTransport !== null) {
          // Close any open app before releasing the transport so the device
          // returns to the dashboard rather than staying stuck in an app.
          if (context.activeApp !== null) {
            try { await deviceCloseApp(activeTransport); } catch { /* best-effort */ }
          }
          await disconnectTransport(activeTransport);
        }
      } catch (error) {
        disconnectError = error;
      } finally {
        invalidateSessions();
        send({ type: 'DISCONNECT' });
        lastError = null;
        options.onDisconnect?.();
      }
      if (disconnectError !== undefined) {
        throw disconnectError instanceof Error
          ? disconnectError
          : new Error(
              typeof disconnectError === 'string'
                ? disconnectError
                : 'Ledger disconnect failed.',
            );
      }
      });
    },

    ensureReady: (ensureOptions = {}): Promise<void> => enqueue(async () => {
      ensureNotDisposed();
      await ensureReadyInternal(ensureOptions);
    }),

    openApp: (appName: string): Promise<void> => enqueue(async () => {
      ensureNotDisposed();
      if (transport === null) {
        throw new HWError(HWErrorCode.TRANSPORT_DISCONNECTED, 'Not connected.');
      }
      openingAppRequirement = {
        name: appName,
        minVersion: '0.0.0',
        cla: 0,
      };
      send({ type: 'OPEN_APP_REQUEST' });
      try {
        await deviceOpenApp(transport, appName);
      } catch (error) {
        return enterAppOpenError(normalizeAppOpenError(error, appName));
      }
      const active = await readVerifiedActiveApp(appName);
      openingAppRequirement = null;
      connector = null;
      connectorRequirement = null;
      send({ type: 'APP_OPENED_RAW', appInfo: active });
    }),

    closeApp: (): Promise<void> => enqueue(async () => {
      ensureNotDisposed();
      if (transport === null) {
        throw new HWError(HWErrorCode.TRANSPORT_DISCONNECTED, 'Not connected.');
      }
      await deviceCloseApp(transport);
      connector = null;
      connectorRequirement = null;
      send({ type: 'APP_CLOSED' });
    }),

    installApp: (
      config: InstallConfig,
      onProgress?: (p: InstallProgress) => void,
    ): Promise<void> => enqueue(async () => {
      ensureNotDisposed();
      if (transport === null) {
        throw new HWError(HWErrorCode.TRANSPORT_DISCONNECTED, 'Not connected.');
      }
      // Reset connector — the install primes the device and may switch modes
      connector = null;
      connectorRequirement = null;
      send({ type: 'APP_CLOSED' });

      const result = await installApp(transport, config, onProgress);
      if (!result.success || result.completedCommands !== result.totalCommands) {
        throw new HWError(
          HWErrorCode.APP_OPEN_FAILED,
          result.error ??
            `App installation incomplete: ${String(result.completedCommands)}/${String(result.totalCommands)} commands succeeded.`,
        );
      }
      emit();
    }),

    getPublicKey: (): Promise<{ readonly x: bigint; readonly y: bigint }> =>
      enqueue(async () => {
        ensureNotDisposed();
        if (connector === null) {
          await ensureReadyInternal();
        }
        if (connector === null) {
          throw new HWError(HWErrorCode.APP_OPEN_FAILED, 'Connector is not ready.');
        }
        return connector.getPublicKey();
      }),

    getWalletArtifacts: (): Promise<RailgunWalletArtifacts> =>
      enqueue(async () => {
        ensureNotDisposed();
        if (connector === null) {
          await ensureReadyInternal();
        }
        if (transport === null) {
          throw new HWError(HWErrorCode.APP_OPEN_FAILED, 'Wallet artifacts are not available.');
        }
        const signer = new RailgunSigner({ transport });
        return signer.getWalletArtifacts();
      }),

    hwSignShield: (derivationIndex: number): Promise<HwSignShieldResult> =>
      enqueue(async () => signShieldOwnershipMarkerInternal(derivationIndex, 'legacy')),

    signShieldOwnershipMarker: (derivationIndex: number): Promise<ShieldOwnershipMarkerResult> =>
      enqueue(async () => signShieldOwnershipMarkerInternal(derivationIndex, 'modern')),

    getEthAddress: (
      derivationIndex: number,
      display = false,
    ): Promise<{ readonly address: string; readonly publicKey: string }> =>
      enqueue(async () => {
        ensureNotDisposed();
        buildEthereumAccountDerivationPath(derivationIndex);
        await ensureStandardAppReady(ETH_APP);
        if (transport === null) {
          throw new HWError(HWErrorCode.TRANSPORT_DISCONNECTED, 'Transport not connected.');
        }
        const ethSigner = new EthSigner({ transport });
        try {
          return await ethSigner.getAddressAtIndex(derivationIndex, display);
        } catch (error) {
          throw normalizeEthOperationError(error, 'Ethereum getAddress failed.');
        }
      }),

    getEthAddressAtPath: (
      derivationPath: string,
      display = false,
    ): Promise<{ readonly address: string; readonly publicKey: string }> =>
      enqueue(async () => {
        ensureNotDisposed();
        const normalizedDerivationPath = normalizeEthereumDerivationPath(derivationPath);
        await ensureStandardAppReady(ETH_APP);
        if (transport === null) {
          throw new HWError(HWErrorCode.TRANSPORT_DISCONNECTED, 'Transport not connected.');
        }
        const ethSigner = new EthSigner({ transport });
        try {
          return await ethSigner.getAddress(normalizedDerivationPath, display);
        } catch (error) {
          throw normalizeEthOperationError(error, 'Ethereum getAddress failed.');
        }
      }),

    signEthTransaction: (rawTxHex: string, derivationIndex: number): Promise<EthSignResult> =>
      enqueue(async () => {
        ensureNotDisposed();
        const normalizedRawTxHex = normalizeRawTransactionHex(rawTxHex);
        buildEthereumAccountDerivationPath(derivationIndex);
        await ensureStandardAppReady(ETH_APP);
        if (transport === null) {
          throw new HWError(HWErrorCode.TRANSPORT_DISCONNECTED, 'Transport not connected.');
        }
        const ethSigner = new EthSigner({ transport });
        beginEthSigning();
        try {
          const result = await ethSigner.signTransaction({
            type: 'eth_tx',
            rawTxHex: normalizedRawTxHex,
            derivationPath: buildEthereumAccountDerivationPath(derivationIndex),
          });
          completeEthSigning();
          return result;
        } catch (error) {
          return failEthSigning(
            normalizeEthOperationError(error, 'Ethereum transaction signing failed.'),
          );
        }
      }),

    signEthMessage: (
      message: string | Uint8Array,
      derivationIndex: number,
    ): Promise<EthSignResult> =>
      enqueue(async () => {
        ensureNotDisposed();
        buildEthereumAccountDerivationPath(derivationIndex);
        await ensureStandardAppReady(ETH_APP);
        if (transport === null) {
          throw new HWError(HWErrorCode.TRANSPORT_DISCONNECTED, 'Transport not connected.');
        }
        const ethSigner = new EthSigner({ transport });
        beginEthSigning();
        try {
          const result = await ethSigner.signPersonalMessageAtIndex(message, derivationIndex);
          completeEthSigning();
          return result;
        } catch (error) {
          return failEthSigning(
            normalizeEthOperationError(error, 'Ethereum personal_sign failed.'),
          );
        }
      }),

    signEthTypedData: (
      payload: { readonly domainSeparatorHex: string; readonly hashStructMessageHex: string },
      derivationIndex: number,
    ): Promise<EthSignResult> =>
      enqueue(async () => {
        ensureNotDisposed();
        buildEthereumAccountDerivationPath(derivationIndex);
        await ensureStandardAppReady(ETH_APP);
        if (transport === null) {
          throw new HWError(HWErrorCode.TRANSPORT_DISCONNECTED, 'Transport not connected.');
        }
        const ethSigner = new EthSigner({ transport });
        beginEthSigning();
        try {
          const result = await ethSigner.signTypedDataAtIndex(payload, derivationIndex);
          completeEthSigning();
          return result;
        } catch (error) {
          return failEthSigning(
            normalizeEthOperationError(error, 'Ethereum EIP-712 sign failed.'),
          );
        }
      }),

    signEthTypedDataAtPath: (
      payload: { readonly domainSeparatorHex: string; readonly hashStructMessageHex: string },
      derivationPath: string,
    ): Promise<EthSignResult> =>
      enqueue(async () => {
        ensureNotDisposed();
        const normalizedDerivationPath = normalizeEthereumDerivationPath(derivationPath);
        await ensureStandardAppReady(ETH_APP);
        if (transport === null) {
          throw new HWError(HWErrorCode.TRANSPORT_DISCONNECTED, 'Transport not connected.');
        }
        const ethSigner = new EthSigner({ transport });
        beginEthSigning();
        try {
          const result = await ethSigner.signTypedData({
            type: 'eth_typed_data',
            domainSeparatorHex: payload.domainSeparatorHex,
            hashStructMessageHex: payload.hashStructMessageHex,
            derivationPath: normalizedDerivationPath,
          });
          completeEthSigning();
          return result;
        } catch (error) {
          return failEthSigning(
            normalizeEthOperationError(error, 'Ethereum EIP-712 sign failed.'),
          );
        }
      }),

    prepareRailgunEthereumSigner: (
      request: RailgunEthereumPreloadRequest,
    ): Promise<RailgunEthereumSignerSession> =>
      enqueue(async () => {
        ensureNotDisposed();
        if (connector === null) {
          await ensureReadyInternal();
        }
        if (transport === null) {
          throw new HWError(HWErrorCode.TRANSPORT_DISCONNECTED, 'Transport not connected.');
        }
        const signer = new RailgunSigner({ transport, account: request.railgunAccountIndex });
        return signer.prepareEthereumSigner(request);
      }),

    signRailgunEthereumHash: (
      hashHex: string,
      session: RailgunEthereumSignerSession,
      display = true,
    ): Promise<EthereumSignatureParts> =>
      enqueue(async () => {
        ensureNotDisposed();
        if (connector === null) {
          await ensureReadyInternal();
        }
        if (transport === null) {
          throw new HWError(HWErrorCode.TRANSPORT_DISCONNECTED, 'Transport not connected.');
        }
        const signer = new RailgunSigner({ transport, account: session.railgunAccountIndex });
        beginEthSigning();
        try {
          const result = await signer.signEthereumTxHash(normalizeHash32Hex(hashHex), { session, display });
          completeEthSigning();
          return result;
        } catch (error) {
          return failEthSigning(
            normalizeEthOperationError(error, 'RAILGUN app Ethereum hash signing failed.'),
          );
        }
      }),

    signRailgunEip7702Authorization: (
      request: {
        readonly session: RailgunEthereumSignerSession;
        readonly contractAddressHex: string;
        readonly nonce: bigint;
      },
    ): Promise<EthereumSignatureParts> =>
      enqueue(async () => {
        ensureNotDisposed();
        if (connector === null) {
          await ensureReadyInternal();
        }
        if (transport === null) {
          throw new HWError(HWErrorCode.TRANSPORT_DISCONNECTED, 'Transport not connected.');
        }
        const signer = new RailgunSigner({ transport, account: request.session.railgunAccountIndex });
        beginEthSigning();
        try {
          const result = await signer.signEip7702Authorization({
            session: request.session,
            chainId: request.session.chainId,
            contractAddress: normalizeAddressHex(request.contractAddressHex),
            nonce: request.nonce,
          });
          completeEthSigning();
          return result;
        } catch (error) {
          return failEthSigning(
            normalizeEthOperationError(error, 'RAILGUN app EIP-7702 authorization signing failed.'),
          );
        }
      }),

    sign: (
      expectedHash: bigint,
      publicInputs?: PublicInputsRailgun,
      subSession?: string,
    ): Promise<Signature> => enqueue(() => signInternal(expectedHash, publicInputs, subSession)),

    requestBatchApproval: (
      requests: readonly RequestApprovalOptions[],
    ): Promise<LedgerBatchApprovalSession> => enqueue(async () => {
      ensureNotDisposed();
      if (connector === null) {
        await ensureReadyInternal();
      }
      if (deviceSessionId === null) {
        throw new HWError(HWErrorCode.TRANSPORT_DISCONNECTED, 'Device session unavailable.');
      }

      const approvalDigest = computeApprovalDigest(requests);
      send({ type: 'BATCH_SIGN_REQUEST', requests });

      const session: LedgerBatchApprovalSession = {
        approved: true,
        subSession: randomId(),
        approvalDigest,
        deviceSessionId,
        createdAt: Date.now(),
        expiresAt: Date.now() + approvalTimeoutMs,
      };

      const approval = createDeferred<LedgerBatchApprovalSession>();
      pendingAction = {
        kind: 'batch',
        requests,
        approvalDigest,
        session,
        resolve: approval.resolve,
        reject: approval.reject,
      };
      emit();
      return approval.promise;
    }),

    approveCurrentAction: (): boolean => {
      if (pendingAction === null) {
        return false;
      }

      if (pendingAction.kind === 'sign') {
        send({ type: 'APPROVE_SIGN' });
        pendingAction.resolve();
        return true;
      }

      send({ type: 'APPROVE_BATCH' });
      activeApprovalSession = pendingAction.session;
      pendingAction.resolve(pendingAction.session);
      return true;
    },

    rejectCurrentAction: (reason?: Error): boolean => {
      if (pendingAction === null) {
        return false;
      }

      const currentPendingAction = pendingAction;

      const rejection = reason
        ?? new HWError(HWErrorCode.SIGN_REJECTED_USER, 'User rejected Ledger approval.');

      if (currentPendingAction.kind === 'sign') {
        send({ type: 'REJECT_SIGN' });
        currentPendingAction.reject(rejection);
        pendingAction = null;
        settleAutoState();
        return true;
      }

      send({ type: 'REJECT_BATCH' });
      currentPendingAction.reject(rejection);
      pendingAction = null;
      activeApprovalSession = null;
      settleAutoState();
      return true;
    },

    getConnector: (): HardwareConnector | null => connector,

    getSnapshot,

    clearDeviceState: (): Promise<ClearStateOutcome> => enqueue(async () => {
      ensureNotDisposed();
      if (transport === null || !transport.isConnected()) {
        return { kind: 'transport_lost' as const };
      }

      const expectedApp = connectorRequirement?.name;
      const outcome = await runClearDeviceState(transport, {
        ...(expectedApp !== undefined ? { expectedApp } : {}),
      });

      switch (outcome.kind) {
        case 'ready': {
          context = { ...context, activeApp: outcome.activeApp };
          lastError = null;
          if (state.startsWith('error.')) {
            send({ type: 'RESET' });
          } else {
            emit();
          }
          return outcome;
        }
        case 'needs_unlock': {
          lastError = new HWError(
            HWErrorCode.DEVICE_LOCKED,
            'Device is locked. Unlock and retry.',
          );
          emit();
          return outcome;
        }
        case 'needs_app_open': {
          // Caller should re-run ensureReady() — we don't auto-open here.
          emit();
          return outcome;
        }
        case 'app_not_installed': {
          send({
            type: 'APP_MISSING',
            error: new HWError(
              HWErrorCode.APP_NOT_INSTALLED,
              `App "${outcome.appName}" is not installed on the device.`,
            ),
          });
          return outcome;
        }
        case 'transport_lost': {
          send({ type: 'TRANSPORT_DISCONNECTED' });
          return outcome;
        }
        case 'unrecoverable': {
          send({ type: 'TRANSPORT_ERROR', error: outcome.error });
          return outcome;
        }
      }
    }),

    clearError: (): void => {
      lastError = null;
      if (state.startsWith('error.')) {
        const activeTransport = transport;
        transport = null;
        connector = null;
        connectorRequirement = null;
        deviceSessionId = null;
        activeApprovalSession = null;
        pendingAction = null;
        send({ type: 'DISCONNECT' });
        if (activeTransport !== null) {
          void disconnectTransport(activeTransport, { swallowErrors: true });
        }
      } else {
        emit();
      }
    },

    subscribe: (listener: LedgerControllerListener): (() => void) => {
      listeners.add(listener);
      listener(getSnapshot());
      return (): void => {
        listeners.delete(listener);
      };
    },

    dispose: (): Promise<void> => {
      cancelPendingAction(
        new HWError(HWErrorCode.TRANSPORT_DISCONNECTED, 'Controller session invalidated.'),
      );

      return enqueue(async () => {
      disposed = true;
      const activeTransport = transport;
      let disconnectError: unknown;
      transport = null;
      try {
        if (activeTransport !== null) {
          await disconnectTransport(activeTransport);
        }
      } catch (error) {
        disconnectError = error;
      } finally {
        invalidateSessions();
        connector = null;
        send({ type: 'DISPOSE' });
      }
      if (disconnectError !== undefined) {
        throw disconnectError instanceof Error
          ? disconnectError
          : new Error(
              typeof disconnectError === 'string'
                ? disconnectError
                : 'Ledger disconnect failed.',
            );
      }
      });
    },
  };
}