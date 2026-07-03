import type {
  ActiveAppInfo,
  AppInfo,
  AppRequirement,
  DeviceInfo,
} from '../../core/device/types.js';
import type { HWError } from '../../core/errors.js';
import type { MachineMode, MachineState } from '../../core/state-machine/types.js';
import type { LedgerModalIntent } from './modal-intents.js';

export type LedgerControllerReadiness =
  | 'disconnected'
  | 'connecting'
  | 'querying_device'
  | 'device_ready'
  | 'app_check'
  | 'app_missing'
  | 'app_outdated'
  | 'opening_app'
  | 'ready'
  | 'error';

export type LedgerControllerAction =
  | 'idle'
  | 'reviewing_sign'
  | 'reviewing_batch'
  | 'awaiting_device_confirmation'
  | 'signing'
  | 'batch_signing'
  | 'complete'
  | 'rejected'
  | 'recoverable_error';

export type LedgerDeviceSession = {
  readonly deviceSessionId: string;
  readonly deviceInfo: DeviceInfo | null;
  readonly activeApp: ActiveAppInfo | null;
  readonly installedApps: readonly AppInfo[];
};

export type LedgerApprovalSessionSummary = {
  readonly subSession: string;
  readonly approvalDigest: string;
  readonly createdAt: number;
  readonly expiresAt?: number;
  readonly remainingApprovals?: number;
};

export type LedgerControllerSnapshot = {
  readonly mode: MachineMode;
  readonly machineState: MachineState;
  readonly readiness: LedgerControllerReadiness;
  readonly action: LedgerControllerAction;
  readonly isBusy: boolean;
  readonly connectorAvailable: boolean;
  readonly requiredApp: AppRequirement | null;
  readonly deviceSession: LedgerDeviceSession | null;
  readonly approvalSession: LedgerApprovalSessionSummary | null;
  readonly modal: LedgerModalIntent;
  readonly error: HWError | null;
};