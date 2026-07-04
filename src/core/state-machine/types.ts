/**
 * State machine types.
 *
 * Defines all states, events, context, and transition types for the
 * central FSM that drives the entire component.
 */

import type { HWTransport } from '../transport/types.js';
import type { DeviceInfo, AppInfo, ActiveAppInfo } from '../device/types.js';
import type {
  Signature,
  PublicInputsRailgun,
  RequestApprovalOptions,
} from '../connector/types.js';
import type { HWError } from '../errors.js';

// ─── States ───────────────────────────────────────────────────────────────────

export type MachineState =
  // Root states
  | 'disconnected'
  | 'connecting'
  | 'requesting_permission'
  // Connected states
  | 'querying_device'
  | 'device_ready'
  | 'app_check'
  | 'app_missing'
  | 'app_outdated'
  | 'app_found'
  | 'opening_app'
  | 'app_ready'
  // Signer states
  | 'signer_idle'
  | 'reviewing'
  | 'confirming'
  | 'signed'
  | 'sign_rejected'
  // Batch signing states
  | 'batch_reviewing'
  | 'batch_approved'
  | 'batch_signing_n'
  | 'batch_complete'
  | 'batch_rejected'
  // ETH signing states
  | 'eth_reviewing'
  | 'eth_confirming'
  | 'eth_complete'
  // Custom APDU states
  | 'apdu_composing'
  | 'apdu_sending'
  | 'apdu_complete'
  // Installer states
  | 'install_idle'
  | 'upload_manifest'
  | 'validating_manifest'
  | 'install_instructions'
  | 'verifying_install'
  // Error states
  | 'error.transport_lost'
  | 'error.protocol_error'
  | 'error.user_rejected'
  | 'error.app_error'
  | 'error.timeout'
  // Terminal
  | 'disposed';

// ─── Events ───────────────────────────────────────────────────────────────────

export type MachineEvent =
  // User-initiated
  | { type: 'CONNECT' }
  | { type: 'DISCONNECT' }
  | { type: 'SELECT_APP'; appId: string }
  | { type: 'APPROVE_SIGN' }
  | { type: 'REJECT_SIGN' }
  | { type: 'APPROVE_BATCH' }
  | { type: 'REJECT_BATCH' }
  | { type: 'SEND_CUSTOM_APDU'; apdu: Uint8Array }
  | { type: 'UPLOAD_MANIFEST'; file: File }
  | { type: 'SWITCH_MODE'; mode: MachineMode }
  | { type: 'RETRY' }
  | { type: 'RESET' }
  // Engine-initiated
  | { type: 'SIGN_REQUEST'; hash: bigint; publicInputs?: PublicInputsRailgun }
  | { type: 'BATCH_SIGN_REQUEST'; requests: readonly RequestApprovalOptions[] }
  | { type: 'ETH_SIGN_REQUEST' }
  | { type: 'ETH_SIGN_COMPLETE' }
  | { type: 'APP_MISSING' }
  | { type: 'APP_OUTDATED'; appInfo?: ActiveAppInfo }
  | { type: 'APP_OPEN_FAILED' }
  | { type: 'OPEN_APP_REQUEST' }
  | { type: 'APP_CLOSED' }
  | { type: 'APP_OPENED_RAW'; appInfo: ActiveAppInfo }
  | { type: 'INSTALL_BEGIN' }
  | { type: 'DISPOSE' }
  // Transport/device-initiated
  | { type: 'TRANSPORT_CONNECTED' }
  | { type: 'TRANSPORT_DISCONNECTED' }
  | { type: 'DEVICE_INFO_RECEIVED'; info: DeviceInfo }
  | { type: 'APPS_LISTED'; apps: readonly AppInfo[] }
  | { type: 'APP_OPENED'; appInfo: ActiveAppInfo }
  | { type: 'APDU_RESPONSE'; data: Uint8Array }
  | { type: 'SIGN_COMPLETE'; signature: Signature }
  | { type: 'DEVICE_REJECTED'; error?: HWError }
  | { type: 'TRANSPORT_ERROR'; error: HWError }
  | { type: 'TIMEOUT' };

// ─── Mode ─────────────────────────────────────────────────────────────────────

export type MachineMode = 'signer' | 'installer';

// ─── Context ──────────────────────────────────────────────────────────────────

export type SignRequest = {
  readonly hash: bigint;
  readonly publicInputs?: PublicInputsRailgun;
};

export type BatchSignRequest = {
  readonly requests: readonly RequestApprovalOptions[];
};

export type MachineContext = {
  readonly mode: MachineMode;
  readonly transport: HWTransport | null;
  readonly deviceInfo: DeviceInfo | null;
  readonly installedApps: readonly AppInfo[];
  readonly activeApp: ActiveAppInfo | null;
  readonly pendingSignRequest: SignRequest | null;
  readonly pendingBatchRequests: BatchSignRequest | null;
  readonly batchSignatures: readonly Signature[];
  readonly batchIndex: number;
  readonly error: HWError | null;
  readonly lastSafeState: MachineState;
};

// ─── Transition ───────────────────────────────────────────────────────────────

export type TransitionResult = {
  readonly state: MachineState;
  readonly context: MachineContext;
};
