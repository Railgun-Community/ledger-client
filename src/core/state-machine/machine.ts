/**
 * State machine — core transition logic.
 *
 * Pure function: (state, context, event) → (newState, newContext)
 * No side effects. Side effects (transport calls, async work) are
 * triggered by the caller based on the returned state.
 *
 * Invariants:
 * - Every transition is explicit — no implicit fallthrough
 * - Transport errors from any state → error state
 * - Error states are always recoverable via RETRY or RESET
 * - disposed is terminal — no transitions out
 * - Context mutations are shallow copies (immutable updates)
 */

import type {
  MachineState,
  MachineEvent,
  MachineContext,
  TransitionResult,
} from './types.js';
import { isSafeState } from './guards.js';

/**
 * Create initial machine context.
 */
export function createInitialContext(
  mode: 'signer' | 'installer' = 'signer',
): MachineContext {
  return {
    mode,
    transport: null,
    deviceInfo: null,
    installedApps: [],
    activeApp: null,
    pendingSignRequest: null,
    pendingBatchRequests: null,
    batchSignatures: [],
    batchIndex: 0,
    error: null,
    lastSafeState: 'disconnected',
  };
}

/**
 * Core transition function.
 *
 * Returns the new state and context. If the event is not handled
 * in the current state, returns the current state unchanged.
 */
export function transition(
  state: MachineState,
  ctx: MachineContext,
  event: MachineEvent,
): TransitionResult {
  // ─── Global transitions (from any non-terminal state) ───────────────────

  if (state === 'disposed') {
    return { state, context: ctx };
  }

  // Transport disconnect from any state → error
  if (event.type === 'TRANSPORT_DISCONNECTED') {
    return {
      state: 'error.transport_lost',
      context: {
        ...ctx,
        transport: null,
        activeApp: null,
        lastSafeState: isSafeState(state) ? state : ctx.lastSafeState,
      },
    };
  }

  // Transport error from any state → error
  if (event.type === 'TRANSPORT_ERROR') {
    return {
      state: 'error.protocol_error',
      context: {
        ...ctx,
        error: event.error,
        lastSafeState: isSafeState(state) ? state : ctx.lastSafeState,
      },
    };
  }

  // Timeout from any state → error
  if (event.type === 'TIMEOUT') {
    return {
      state: 'error.timeout',
      context: {
        ...ctx,
        lastSafeState: isSafeState(state) ? state : ctx.lastSafeState,
      },
    };
  }

  // DISCONNECT from any state → cleanup
  if (event.type === 'DISCONNECT') {
    return {
      state: 'disconnected',
      context: {
        ...ctx,
        transport: null,
        deviceInfo: null,
        installedApps: [],
        activeApp: null,
        pendingSignRequest: null,
        pendingBatchRequests: null,
        batchSignatures: [],
        batchIndex: 0,
        error: null,
      },
    };
  }

  // App availability is orthogonal to sub-state — surface it from any state.
  if (event.type === 'APP_MISSING') {
    return { state: 'app_missing', context: ctx };
  }
  if (event.type === 'APP_OUTDATED') {
    return {
      state: 'app_outdated',
      context: {
        ...ctx,
        ...(event.appInfo !== undefined ? { activeApp: event.appInfo } : {}),
        lastSafeState: 'device_ready',
      },
    };
  }

  // DISPOSE from any non-terminal state → terminal.
  if (event.type === 'DISPOSE') {
    return { state: 'disposed', context: createInitialContext(ctx.mode) };
  }

  // RESET from error states → disconnected
  if (event.type === 'RESET' && state.startsWith('error.')) {
    return {
      state: 'disconnected',
      context: {
        ...ctx,
        transport: null,
        deviceInfo: null,
        installedApps: [],
        activeApp: null,
        pendingSignRequest: null,
        pendingBatchRequests: null,
        batchSignatures: [],
        batchIndex: 0,
        error: null,
      },
    };
  }

  // RETRY from error states → last safe state
  if (event.type === 'RETRY' && state.startsWith('error.')) {
    return {
      state: ctx.lastSafeState,
      context: { ...ctx, error: null },
    };
  }

  // ─── State-specific transitions ─────────────────────────────────────────

  switch (state) {
    case 'disconnected':
      return handleDisconnected(ctx, event);

    case 'connecting':
    case 'requesting_permission':
      return handleConnecting(state, ctx, event);

    case 'querying_device':
      return handleQueryingDevice(ctx, event);

    case 'device_ready':
    case 'app_check':
      return handleDeviceReady(state, ctx, event);

    case 'app_missing':
      return handleAppMissing(ctx, event);

    case 'app_outdated':
      return handleAppOutdated(ctx, event);

    case 'app_found':
      return handleAppFound(ctx, event);

    case 'opening_app':
      return handleOpeningApp(ctx, event);

    case 'app_ready':
    case 'signer_idle':
      return handleSignerIdle(state, ctx, event);

    case 'reviewing':
      return handleReviewing(ctx, event);

    case 'confirming':
      return handleConfirming(ctx, event);

    case 'signed':
      return handleSigned(ctx, event);

    case 'sign_rejected':
      return handleSignRejected(ctx, event);

    // ─ Batch signing ──────────────────────────────────────────────────────
    case 'batch_reviewing':
      return handleBatchReviewing(ctx, event);

    case 'batch_approved':
    case 'batch_signing_n':
      return handleBatchSigningN(ctx, event);

    case 'batch_complete':
      return handleBatchComplete(ctx, event);

    case 'batch_rejected':
      return handleBatchRejected(ctx, event);

    // ─ ETH signing ────────────────────────────────────────────────────────
    case 'eth_reviewing':
      return handleEthReviewing(ctx, event);

    case 'eth_confirming':
      return handleEthConfirming(ctx, event);

    case 'eth_complete':
      return handleEthComplete(ctx, event);

    // ─ Custom APDU ────────────────────────────────────────────────────────
    case 'apdu_composing':
      return handleApduComposing(ctx, event);

    case 'apdu_sending':
      return handleApduSending(ctx, event);

    case 'apdu_complete':
      return handleApduComplete(ctx, event);

    // ─ Installer ──────────────────────────────────────────────────────────
    case 'install_idle':
      return handleInstallIdle(ctx, event);

    case 'upload_manifest':
      return handleUploadManifest(ctx, event);

    case 'validating_manifest':
      return handleValidatingManifest(ctx, event);

    case 'install_instructions':
      return handleInstallInstructions(ctx, event);

    case 'verifying_install':
      return handleVerifyingInstall(ctx, event);

    // ─ Error states handled by global RETRY/RESET above ───────────────────
    case 'error.transport_lost':
    case 'error.protocol_error':
    case 'error.user_rejected':
    case 'error.app_error':
    case 'error.timeout':
      return { state, context: ctx };

    default:
      return assertExhaustive(state, ctx);
  }
}

/**
 * Compile-time exhaustiveness guard: every non-terminal `MachineState` must have
 * an explicit handler in the switch above. If a new state is added without one,
 * `state` is no longer `never` here and this fails to type-check. At runtime an
 * unexpected state is returned unchanged (no behavior change from before).
 */
function assertExhaustive(state: never, ctx: MachineContext): TransitionResult {
  return { state, context: ctx };
}

// ─── State handlers ─────────────────────────────────────────────────────────

function handleDisconnected(
  ctx: MachineContext,
  event: MachineEvent,
): TransitionResult {
  if (event.type === 'CONNECT') {
    return { state: 'connecting', context: ctx };
  }
  if (event.type === 'SWITCH_MODE') {
    return {
      state: 'disconnected',
      context: { ...ctx, mode: event.mode },
    };
  }
  return { state: 'disconnected', context: ctx };
}

function handleConnecting(
  state: MachineState,
  ctx: MachineContext,
  event: MachineEvent,
): TransitionResult {
  if (event.type === 'TRANSPORT_CONNECTED') {
    return { state: 'querying_device', context: ctx };
  }
  return { state, context: ctx };
}

function handleQueryingDevice(
  ctx: MachineContext,
  event: MachineEvent,
): TransitionResult {
  if (event.type === 'DEVICE_INFO_RECEIVED') {
    return {
      state: 'device_ready',
      context: { ...ctx, deviceInfo: event.info },
    };
  }
  if (event.type === 'APP_OPENED') {
    return {
      state: 'signer_idle',
      context: { ...ctx, activeApp: event.appInfo, lastSafeState: 'signer_idle' },
    };
  }
  if (event.type === 'APP_CLOSED') {
    return { state: 'device_ready', context: { ...ctx, activeApp: null } };
  }
  if (event.type === 'OPEN_APP_REQUEST') {
    return { state: 'opening_app', context: ctx };
  }
  return { state: 'querying_device', context: ctx };
}

function handleDeviceReady(
  state: MachineState,
  ctx: MachineContext,
  event: MachineEvent,
): TransitionResult {
  if (event.type === 'APPS_LISTED') {
    return {
      state: 'app_check',
      context: { ...ctx, installedApps: event.apps },
    };
  }
  if (event.type === 'APP_OPENED') {
    return {
      state: 'signer_idle',
      context: { ...ctx, activeApp: event.appInfo, lastSafeState: 'signer_idle' },
    };
  }
  if (event.type === 'OPEN_APP_REQUEST') {
    return { state: 'opening_app', context: ctx };
  }
  if (event.type === 'APP_CLOSED') {
    return { state: 'device_ready', context: { ...ctx, activeApp: null } };
  }
  if (event.type === 'SWITCH_MODE') {
    if (event.mode === 'installer') {
      return {
        state: 'install_idle',
        context: {
          ...ctx,
          mode: 'installer',
          lastSafeState: 'install_idle',
        },
      };
    }
    return {
      state: 'device_ready',
      context: { ...ctx, mode: event.mode },
    };
  }
  return { state, context: ctx };
}

function handleAppMissing(
  ctx: MachineContext,
  event: MachineEvent,
): TransitionResult {
  if (event.type === 'SWITCH_MODE' && event.mode === 'installer') {
    return {
      state: 'install_idle',
      context: { ...ctx, mode: 'installer', lastSafeState: 'install_idle' },
    };
  }
  // Retry refreshes app list
  if (event.type === 'RETRY') {
    return { state: 'device_ready', context: ctx };
  }
  return { state: 'app_missing', context: ctx };
}

function handleAppOutdated(
  ctx: MachineContext,
  event: MachineEvent,
): TransitionResult {
  if (event.type === 'SWITCH_MODE' && event.mode === 'installer') {
    return {
      state: 'install_idle',
      context: { ...ctx, mode: 'installer', lastSafeState: 'install_idle' },
    };
  }
  if (event.type === 'RETRY') {
    return { state: 'device_ready', context: ctx };
  }
  return { state: 'app_outdated', context: ctx };
}

function handleAppFound(
  _ctx: MachineContext,
  _event: MachineEvent,
): TransitionResult {
  // app_found auto-transitions to opening_app — handled by the caller
  // If we get here, treat any event as moving forward
  return { state: 'opening_app', context: _ctx };
}

function handleOpeningApp(
  ctx: MachineContext,
  event: MachineEvent,
): TransitionResult {
  if (event.type === 'APP_OPENED') {
    return {
      state: 'signer_idle',
      context: {
        ...ctx,
        activeApp: event.appInfo,
        lastSafeState: 'signer_idle',
      },
    };
  }
  if (event.type === 'DEVICE_REJECTED') {
    return {
      state: 'error.user_rejected',
      context: {
        ...ctx,
        ...(event.error !== undefined ? { error: event.error } : {}),
        lastSafeState: 'device_ready',
      },
    };
  }
  if (event.type === 'APP_OPEN_FAILED') {
    return {
      state: 'error.app_error',
      context: { ...ctx, lastSafeState: 'device_ready' },
    };
  }
  if (event.type === 'APP_OPENED_RAW') {
    return {
      state: 'device_ready',
      context: { ...ctx, activeApp: event.appInfo, lastSafeState: 'device_ready' },
    };
  }
  return { state: 'opening_app', context: ctx };
}

function handleSignerIdle(
  state: MachineState,
  ctx: MachineContext,
  event: MachineEvent,
): TransitionResult {
  if (event.type === 'SIGN_REQUEST') {
    return {
      state: 'reviewing',
      context: {
        ...ctx,
        pendingSignRequest: event.publicInputs !== undefined
          ? { hash: event.hash, publicInputs: event.publicInputs }
          : { hash: event.hash },
      },
    };
  }
  if (event.type === 'BATCH_SIGN_REQUEST') {
    return {
      state: 'batch_reviewing',
      context: {
        ...ctx,
        pendingBatchRequests: { requests: event.requests },
        batchSignatures: [],
        batchIndex: 0,
      },
    };
  }
  if (event.type === 'ETH_SIGN_REQUEST') {
    return {
      state: 'eth_confirming',
      context: { ...ctx, lastSafeState: 'signer_idle' },
    };
  }
  if (event.type === 'OPEN_APP_REQUEST') {
    return { state: 'opening_app', context: ctx };
  }
  if (event.type === 'APP_CLOSED') {
    return { state: 'device_ready', context: { ...ctx, activeApp: null } };
  }
  if (event.type === 'SWITCH_MODE') {
    if (event.mode === 'installer') {
      return {
        state: 'install_idle',
        context: { ...ctx, mode: 'installer', lastSafeState: 'install_idle' },
      };
    }
  }
  return { state, context: ctx };
}

function handleReviewing(
  ctx: MachineContext,
  event: MachineEvent,
): TransitionResult {
  if (event.type === 'APPROVE_SIGN') {
    return { state: 'confirming', context: ctx };
  }
  if (event.type === 'REJECT_SIGN') {
    return {
      state: 'signer_idle',
      context: {
        ...ctx,
        pendingSignRequest: null,
        lastSafeState: 'signer_idle',
      },
    };
  }
  return { state: 'reviewing', context: ctx };
}

function handleConfirming(
  ctx: MachineContext,
  event: MachineEvent,
): TransitionResult {
  if (event.type === 'SIGN_COMPLETE') {
    return {
      state: 'signed',
      context: ctx,
    };
  }
  if (event.type === 'DEVICE_REJECTED') {
    return {
      state: 'sign_rejected',
      context: ctx,
    };
  }
  return { state: 'confirming', context: ctx };
}

function handleSigned(
  ctx: MachineContext,
  _event: MachineEvent,
): TransitionResult {
  // signed auto-transitions back to signer_idle
  return {
    state: 'signer_idle',
    context: {
      ...ctx,
      pendingSignRequest: null,
      lastSafeState: 'signer_idle',
    },
  };
}

function handleSignRejected(
  ctx: MachineContext,
  _event: MachineEvent,
): TransitionResult {
  // sign_rejected auto-transitions back to signer_idle
  return {
    state: 'signer_idle',
    context: {
      ...ctx,
      pendingSignRequest: null,
      lastSafeState: 'signer_idle',
    },
  };
}

// ─── Batch signing ────────────────────────────────────────────────────────

function handleBatchReviewing(
  ctx: MachineContext,
  event: MachineEvent,
): TransitionResult {
  if (event.type === 'APPROVE_BATCH') {
    return { state: 'batch_signing_n', context: ctx };
  }
  if (event.type === 'REJECT_BATCH') {
    return {
      state: 'batch_rejected',
      context: ctx,
    };
  }
  return { state: 'batch_reviewing', context: ctx };
}

function handleBatchSigningN(
  ctx: MachineContext,
  event: MachineEvent,
): TransitionResult {
  if (event.type === 'SIGN_COMPLETE') {
    const newSigs = [...ctx.batchSignatures, event.signature];
    const nextIndex = ctx.batchIndex + 1;
    const total = ctx.pendingBatchRequests?.requests.length ?? 0;

    if (nextIndex >= total) {
      return {
        state: 'batch_complete',
        context: {
          ...ctx,
          batchSignatures: newSigs,
          batchIndex: nextIndex,
        },
      };
    }

    return {
      state: 'batch_signing_n',
      context: {
        ...ctx,
        batchSignatures: newSigs,
        batchIndex: nextIndex,
      },
    };
  }
  if (event.type === 'DEVICE_REJECTED') {
    return {
      state: 'batch_rejected',
      context: ctx,
    };
  }
  return { state: 'batch_signing_n', context: ctx };
}

function handleBatchComplete(
  ctx: MachineContext,
  _event: MachineEvent,
): TransitionResult {
  // Auto-transition back to signer_idle
  return {
    state: 'signer_idle',
    context: {
      ...ctx,
      pendingBatchRequests: null,
      batchSignatures: [],
      batchIndex: 0,
      lastSafeState: 'signer_idle',
    },
  };
}

function handleBatchRejected(
  ctx: MachineContext,
  _event: MachineEvent,
): TransitionResult {
  return {
    state: 'signer_idle',
    context: {
      ...ctx,
      pendingBatchRequests: null,
      batchSignatures: [],
      batchIndex: 0,
      lastSafeState: 'signer_idle',
    },
  };
}

// ─── ETH signing ──────────────────────────────────────────────────────────

function handleEthReviewing(
  ctx: MachineContext,
  event: MachineEvent,
): TransitionResult {
  if (event.type === 'APPROVE_SIGN') {
    return { state: 'eth_confirming', context: ctx };
  }
  if (event.type === 'REJECT_SIGN') {
    return {
      state: 'signer_idle',
      context: { ...ctx, lastSafeState: 'signer_idle' },
    };
  }
  return { state: 'eth_reviewing', context: ctx };
}

function handleEthConfirming(
  ctx: MachineContext,
  event: MachineEvent,
): TransitionResult {
  if (event.type === 'SIGN_COMPLETE' || event.type === 'ETH_SIGN_COMPLETE') {
    return { state: 'eth_complete', context: ctx };
  }
  if (event.type === 'DEVICE_REJECTED') {
    return {
      state: 'sign_rejected',
      context: { ...ctx, lastSafeState: 'signer_idle' },
    };
  }
  return { state: 'eth_confirming', context: ctx };
}

function handleEthComplete(
  ctx: MachineContext,
  _event: MachineEvent,
): TransitionResult {
  return {
    state: 'signer_idle',
    context: { ...ctx, lastSafeState: 'signer_idle' },
  };
}

// ─── Custom APDU ──────────────────────────────────────────────────────────

function handleApduComposing(
  ctx: MachineContext,
  event: MachineEvent,
): TransitionResult {
  if (event.type === 'SEND_CUSTOM_APDU') {
    return { state: 'apdu_sending', context: ctx };
  }
  return { state: 'apdu_composing', context: ctx };
}

function handleApduSending(
  ctx: MachineContext,
  event: MachineEvent,
): TransitionResult {
  if (event.type === 'APDU_RESPONSE') {
    return { state: 'apdu_complete', context: ctx };
  }
  return { state: 'apdu_sending', context: ctx };
}

function handleApduComplete(
  ctx: MachineContext,
  _event: MachineEvent,
): TransitionResult {
  return {
    state: 'signer_idle',
    context: { ...ctx, lastSafeState: 'signer_idle' },
  };
}

// ─── Installer ────────────────────────────────────────────────────────────

function handleInstallIdle(
  ctx: MachineContext,
  event: MachineEvent,
): TransitionResult {
  if (event.type === 'UPLOAD_MANIFEST') {
    return { state: 'upload_manifest', context: ctx };
  }
  if (event.type === 'SWITCH_MODE' && event.mode === 'signer') {
    return {
      state: 'signer_idle',
      context: { ...ctx, mode: 'signer', lastSafeState: 'signer_idle' },
    };
  }
  return { state: 'install_idle', context: ctx };
}

function handleUploadManifest(
  ctx: MachineContext,
  event: MachineEvent,
): TransitionResult {
  if (event.type === 'UPLOAD_MANIFEST') {
    return { state: 'validating_manifest', context: ctx };
  }
  return { state: 'upload_manifest', context: ctx };
}

function handleValidatingManifest(
  ctx: MachineContext,
  event: MachineEvent,
): TransitionResult {
  // Validation result handled externally; assume success transitions
  if (event.type === 'APPROVE_SIGN') {
    // Repurposed: manifest validated successfully
    return { state: 'install_instructions', context: ctx };
  }
  if (event.type === 'REJECT_SIGN') {
    // Repurposed: manifest validation failed
    return {
      state: 'error.app_error',
      context: { ...ctx, lastSafeState: 'install_idle' },
    };
  }
  return { state: 'validating_manifest', context: ctx };
}

function handleInstallInstructions(
  ctx: MachineContext,
  event: MachineEvent,
): TransitionResult {
  if (event.type === 'APPROVE_SIGN') {
    // User confirms they've completed installation
    return { state: 'verifying_install', context: ctx };
  }
  return { state: 'install_instructions', context: ctx };
}

function handleVerifyingInstall(
  ctx: MachineContext,
  event: MachineEvent,
): TransitionResult {
  if (event.type === 'APPS_LISTED') {
    // Refresh app list, then go back to install_idle
    return {
      state: 'install_idle',
      context: {
        ...ctx,
        installedApps: event.apps,
        lastSafeState: 'install_idle',
      },
    };
  }
  return { state: 'verifying_install', context: ctx };
}
