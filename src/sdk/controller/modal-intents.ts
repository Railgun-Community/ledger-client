import type { ActiveAppInfo, AppRequirement } from '../../core/device/types.js';
import type {
  PublicInputsRailgun,
  RequestApprovalOptions,
} from '../../core/connector/types.js';
import type { HWError } from '../../core/errors.js';

export type LedgerReviewSignIntent = {
  readonly kind: 'review_sign';
  readonly hash: bigint;
  readonly publicInputs?: PublicInputsRailgun;
  readonly subSession?: string;
};

export type LedgerReviewBatchIntent = {
  readonly kind: 'review_batch';
  readonly requests: readonly RequestApprovalOptions[];
  readonly approvalDigest: string;
};

export type LedgerModalIntent =
  | { readonly kind: 'none' }
  | { readonly kind: 'connect_hardware' }
  | { readonly kind: 'request_browser_permission' }
  | {
      readonly kind: 'open_required_app';
      readonly requiredApp: AppRequirement;
      readonly activeApp: ActiveAppInfo | null;
    }
  | {
      readonly kind: 'app_missing';
      readonly requiredApp: AppRequirement;
    }
  | {
      readonly kind: 'app_outdated';
      readonly requiredApp: AppRequirement;
      readonly activeApp: ActiveAppInfo;
    }
  | LedgerReviewSignIntent
  | LedgerReviewBatchIntent
  | {
      readonly kind: 'signing_progress';
      readonly step: 'preparing' | 'awaiting_device' | 'signing' | 'verifying';
      readonly hash?: bigint;
      readonly currentIndex?: number;
      readonly total?: number;
    }
  | {
      readonly kind: 'device_rejected';
      readonly error: HWError;
    }
  | {
      readonly kind: 'recoverable_error';
      readonly error: HWError;
      readonly canRetry: boolean;
    }
  | {
      readonly kind: 'transport_disconnected';
      readonly error?: HWError;
    };