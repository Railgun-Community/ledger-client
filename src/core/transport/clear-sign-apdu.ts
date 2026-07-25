/**
 * CLEAR_SIGN transact protocol (INS 0x11) — pure APDU builders + shape validator.
 *
 * Firmware 1.6.1 clear-signs a RAILGUN transact through a stateful, multi-step
 * session where P1 selects the sub-command and P2 is always 0x00. The host
 * streams the transact shape (init), one nullifier per input, the bound-params
 * fields, then one APDU per output, and finally FINALIZE — at which point the
 * device shows the review and EdDSA-Poseidon signs on Approve.
 *
 * Canonical single-tx ordering:
 *   CS_INIT → NULLIFIER×n → BP_FIELDS → [OUT_BROADCASTER] → [OUT_CHANGE]
 *           → (OUT_TRANSFER | OUT_UNSHIELD) → FINALIZE
 *
 * These builders are pure (request → ApduCommand). Byte layouts and the worked
 * golden vectors are from RAILGUN-HW/js/README.md and js/clear-sign-apdus.js.
 * The session orchestration (sending them in order, collecting responses) and
 * the FINALIZE-response parsing live elsewhere — see parseClearSignFinalize in
 * validation/apdu-response.ts.
 */

import type { ApduCommand } from './types.js';
import type { ApduProfile } from './apdu-profile.js';
import { RAILGUN_PROFILE } from './apdu-profile.js';
import { encodeAccountIndex } from './apdu.js';

/** P1 sub-command selector for the CLEAR_SIGN (INS 0x11) session. */
export const ClearSignP1 = {
  INIT: 0x00,
  BP_FIELDS: 0x10,
  NULLIFIER: 0x20,
  OUT_BROADCASTER: 0x30,
  OUT_CHANGE: 0x31,
  OUT_TRANSFER: 0x32,
  OUT_UNSHIELD: 0x33,
  FINALIZE: 0x40,
} as const;

/** Memo cap — matches the device `CS_MAX_MEMO_LEN`. */
export const CLEAR_SIGN_MAX_MEMO_LEN = 32;

/** minGasPrice is a uint48 on the wire (narrowed post-audit S13). */
export const CLEAR_SIGN_MIN_GAS_PRICE_MAX = 1n << 48n;

/** Transfer output type — 0 = Transfer. */
export const CLEAR_SIGN_OUTPUT_TYPE_TRANSFER = 0;

/**
 * Per-output device response lengths, measured on firmware 1.6.1 clear-sign-v1.
 * The device returns opaque ciphertext material the host later splices into the
 * on-chain transact calldata; the orchestrator length-checks and collects it raw.
 */
export const CLEAR_SIGN_OUTPUT_TUPLE_RESPONSE_LENGTH = 223; // OUT_BROADCASTER / OUT_CHANGE
export const CLEAR_SIGN_TRANSFER_RESPONSE_LENGTH = 239; // OUT_TRANSFER (tuple + senderRandom + ann_iv)
export const CLEAR_SIGN_UNSHIELD_RESPONSE_LENGTH = 32; // OUT_UNSHIELD commitment

// ─── Encoding helpers ─────────────────────────────────────────────────────────

function encodeUintBE(value: bigint, byteLength: number, label: string): Uint8Array {
  if (value < 0n || value >= 1n << BigInt(byteLength * 8)) {
    throw new Error(`${label} must fit in an unsigned ${String(byteLength * 8)}-bit integer, got ${String(value)}`);
  }
  const out = new Uint8Array(byteLength);
  let v = value;
  for (let i = byteLength - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function assertBytes(value: Uint8Array, length: number, label: string): void {
  if (value.length !== length) {
    throw new Error(`${label} must be exactly ${String(length)} bytes, got ${String(value.length)}`);
  }
}

function clearSignIns(profile: ApduProfile): number {
  const command = profile.commands.clearSign;
  if (command === undefined) {
    throw new Error(`Profile "${profile.name}" does not support clearSign`);
  }
  return command.ins;
}

function concatBytes(...chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * Encode an ERC-20 token address (20 bytes) as the 32-byte tokenHash the
 * protocol uses: 12 zero bytes ‖ address.
 */
export function encodeErc20TokenHash(address: Uint8Array): Uint8Array {
  assertBytes(address, 20, 'ERC-20 token address');
  const out = new Uint8Array(32);
  out.set(address, 12);
  return out;
}

// ─── Shape validation ─────────────────────────────────────────────────────────

/**
 * Validate the transact (n inputs, m outputs) shape against the device limits:
 * n,m ∈ [1,3] and n+m ≤ 5 (the device Poseidon msgHash arity is 2+n+m ≤ 7).
 */
export function validateClearSignShape(nIn: number, nOut: number): void {
  for (const [label, value] of [['nIn', nIn], ['nOut', nOut]] as const) {
    if (!Number.isInteger(value) || value < 1 || value > 3) {
      throw new Error(`CLEAR_SIGN ${label} must be an integer in [1, 3], got ${String(value)}`);
    }
  }
  if (nIn + nOut > 5) {
    throw new Error(`CLEAR_SIGN shape n+m must be ≤ 5 (device Poseidon arity cap), got n=${String(nIn)} m=${String(nOut)}`);
  }
}

// ─── Request types ────────────────────────────────────────────────────────────

export type ClearSignInitRequest = {
  readonly account?: number;
  /** 32-byte merkle root. */
  readonly merkleRoot: Uint8Array;
  /** Number of inputs (nullifiers), 1..3. */
  readonly nIn: number;
  /** Number of device outputs, 1..3. */
  readonly nOut: number;
};

export type ClearSignBpFieldsRequest = {
  readonly treeNumber: number;
  /** uint48 — values ≥ 2^48 are rejected. */
  readonly minGasPrice: bigint;
  readonly unshield: boolean;
  readonly chainId: bigint;
  /** 20-byte RelayAdapt contract; defaults to all-zero (non-adapt). */
  readonly adaptContract?: Uint8Array;
  /** 32-byte adapt params; defaults to all-zero (non-adapt). */
  readonly adaptParams?: Uint8Array;
};

export type ClearSignBroadcasterOutput = {
  /** 32-byte recipient master public key. */
  readonly recipientMasterPublicKey: Uint8Array;
  /** 32-byte recipient viewing public key. */
  readonly recipientViewingPublicKey: Uint8Array;
  /** 32-byte tokenHash (see encodeErc20TokenHash). */
  readonly tokenHash: Uint8Array;
  readonly value: bigint;
};

export type ClearSignChangeOutput = {
  readonly tokenHash: Uint8Array;
  readonly value: bigint;
};

export type ClearSignTransferOutput = {
  /** 127-character 0zk1… recipient address. */
  readonly recipient0zk: string;
  readonly tokenHash: Uint8Array;
  readonly value: bigint;
  /** Output type byte (default 0 = Transfer). */
  readonly outputType?: number;
  /** Optional memo, ≤ 32 bytes. The device generates the annotation itself. */
  readonly memo?: Uint8Array;
};

export type ClearSignUnshieldOutput = {
  /** 20-byte on-chain recipient address. */
  readonly recipientAddress: Uint8Array;
  readonly tokenHash: Uint8Array;
  readonly value: bigint;
};

// ─── Builders ─────────────────────────────────────────────────────────────────

/** CS_INIT (P1 0x00): account(4) ‖ merkleRoot(32) ‖ nIn(1) ‖ nOut(1). */
export function buildClearSignInit(
  request: ClearSignInitRequest,
  profile: ApduProfile = RAILGUN_PROFILE,
): ApduCommand {
  assertBytes(request.merkleRoot, 32, 'CLEAR_SIGN merkleRoot');
  validateClearSignShape(request.nIn, request.nOut);
  const data = concatBytes(
    encodeAccountIndex(request.account ?? 0),
    request.merkleRoot,
    new Uint8Array([request.nIn, request.nOut]),
  );
  return { cla: profile.cla, ins: clearSignIns(profile), p1: ClearSignP1.INIT, p2: 0, data };
}

/** NULLIFIER (P1 0x20): one 32-byte nullifier per input. */
export function buildClearSignNullifier(
  nullifier: Uint8Array,
  profile: ApduProfile = RAILGUN_PROFILE,
): ApduCommand {
  assertBytes(nullifier, 32, 'CLEAR_SIGN nullifier');
  return { cla: profile.cla, ins: clearSignIns(profile), p1: ClearSignP1.NULLIFIER, p2: 0, data: nullifier.slice() };
}

/**
 * BP_FIELDS (P1 0x10): treeNumber(2) ‖ minGasPrice(6) ‖ unshield(1) ‖
 * chainID(8) ‖ adaptContract(20) ‖ adaptParams(32) = 69 bytes.
 */
export function buildClearSignBpFields(
  request: ClearSignBpFieldsRequest,
  profile: ApduProfile = RAILGUN_PROFILE,
): ApduCommand {
  if (request.minGasPrice < 0n || request.minGasPrice >= CLEAR_SIGN_MIN_GAS_PRICE_MAX) {
    throw new Error(`CLEAR_SIGN minGasPrice must be a uint48 (< 2^48), got ${String(request.minGasPrice)}`);
  }
  const adaptContract = request.adaptContract ?? new Uint8Array(20);
  const adaptParams = request.adaptParams ?? new Uint8Array(32);
  assertBytes(adaptContract, 20, 'CLEAR_SIGN adaptContract');
  assertBytes(adaptParams, 32, 'CLEAR_SIGN adaptParams');
  const data = concatBytes(
    encodeUintBE(BigInt(request.treeNumber), 2, 'treeNumber'),
    encodeUintBE(request.minGasPrice, 6, 'minGasPrice'),
    new Uint8Array([request.unshield ? 1 : 0]),
    encodeUintBE(request.chainId, 8, 'chainId'),
    adaptContract,
    adaptParams,
  );
  return { cla: profile.cla, ins: clearSignIns(profile), p1: ClearSignP1.BP_FIELDS, p2: 0, data };
}

/**
 * OUT_BROADCASTER (P1 0x30): MPK(32) ‖ VKpub(32) ‖ tokenHash(32) ‖ value(32) ‖
 * ann_len(2)=0 ‖ memo_len(2)=0. The device generates the annotation/memo, so
 * both length prefixes are sent empty (matches the reference).
 */
export function buildClearSignOutBroadcaster(
  output: ClearSignBroadcasterOutput,
  profile: ApduProfile = RAILGUN_PROFILE,
): ApduCommand {
  assertBytes(output.recipientMasterPublicKey, 32, 'broadcaster recipientMasterPublicKey');
  assertBytes(output.recipientViewingPublicKey, 32, 'broadcaster recipientViewingPublicKey');
  assertBytes(output.tokenHash, 32, 'broadcaster tokenHash');
  const data = concatBytes(
    output.recipientMasterPublicKey,
    output.recipientViewingPublicKey,
    output.tokenHash,
    encodeUintBE(output.value, 32, 'broadcaster value'),
    new Uint8Array([0, 0, 0, 0]),
  );
  return { cla: profile.cla, ins: clearSignIns(profile), p1: ClearSignP1.OUT_BROADCASTER, p2: 0, data };
}

/** OUT_CHANGE (P1 0x31): tokenHash(32) ‖ value(32) ‖ ann_len(2)=0 ‖ memo_len(2)=0. */
export function buildClearSignOutChange(
  output: ClearSignChangeOutput,
  profile: ApduProfile = RAILGUN_PROFILE,
): ApduCommand {
  assertBytes(output.tokenHash, 32, 'change tokenHash');
  const data = concatBytes(
    output.tokenHash,
    encodeUintBE(output.value, 32, 'change value'),
    new Uint8Array([0, 0, 0, 0]),
  );
  return { cla: profile.cla, ins: clearSignIns(profile), p1: ClearSignP1.OUT_CHANGE, p2: 0, data };
}

/**
 * OUT_TRANSFER (P1 0x32): recipient0zk(127 ASCII) ‖ tokenHash(32) ‖ value(32) ‖
 * outputType(1) ‖ memo_len(2 BE) ‖ memo(0..32). The annotation is device-generated.
 */
export function buildClearSignOutTransfer(
  output: ClearSignTransferOutput,
  profile: ApduProfile = RAILGUN_PROFILE,
): ApduCommand {
  const recipient = encodeAscii127(output.recipient0zk);
  assertBytes(output.tokenHash, 32, 'transfer tokenHash');
  const memo = output.memo ?? new Uint8Array(0);
  if (memo.length > CLEAR_SIGN_MAX_MEMO_LEN) {
    throw new Error(`CLEAR_SIGN memo must be ≤ ${String(CLEAR_SIGN_MAX_MEMO_LEN)} bytes, got ${String(memo.length)}`);
  }
  const outputType = output.outputType ?? CLEAR_SIGN_OUTPUT_TYPE_TRANSFER;
  if (!Number.isInteger(outputType) || outputType < 0 || outputType > 0xff) {
    throw new Error(`CLEAR_SIGN outputType must be a byte, got ${String(outputType)}`);
  }
  const data = concatBytes(
    recipient,
    output.tokenHash,
    encodeUintBE(output.value, 32, 'transfer value'),
    new Uint8Array([outputType]),
    encodeUintBE(BigInt(memo.length), 2, 'memo_len'),
    memo,
  );
  return { cla: profile.cla, ins: clearSignIns(profile), p1: ClearSignP1.OUT_TRANSFER, p2: 0, data };
}

/** OUT_UNSHIELD (P1 0x33): recipientAddr(20) ‖ tokenHash(32) ‖ value(32) = 84 bytes. */
export function buildClearSignOutUnshield(
  output: ClearSignUnshieldOutput,
  profile: ApduProfile = RAILGUN_PROFILE,
): ApduCommand {
  assertBytes(output.recipientAddress, 20, 'unshield recipientAddress');
  assertBytes(output.tokenHash, 32, 'unshield tokenHash');
  const data = concatBytes(
    output.recipientAddress,
    output.tokenHash,
    encodeUintBE(output.value, 32, 'unshield value'),
  );
  return { cla: profile.cla, ins: clearSignIns(profile), p1: ClearSignP1.OUT_UNSHIELD, p2: 0, data };
}

/** FINALIZE (P1 0x40): one dummy filler byte (the dispatcher rejects Lc=0). */
export function buildClearSignFinalize(profile: ApduProfile = RAILGUN_PROFILE): ApduCommand {
  return { cla: profile.cla, ins: clearSignIns(profile), p1: ClearSignP1.FINALIZE, p2: 0, data: new Uint8Array([0]) };
}

// ─── Session orchestration surface ────────────────────────────────────────────

/** A transact output, tagged so the orchestrator can pick the right OUT_* sub-command. */
export type ClearSignOutput =
  | ({ readonly kind: 'broadcaster' } & ClearSignBroadcasterOutput)
  | ({ readonly kind: 'change' } & ClearSignChangeOutput)
  | ({ readonly kind: 'transfer' } & ClearSignTransferOutput)
  | ({ readonly kind: 'unshield' } & ClearSignUnshieldOutput);

/**
 * Build the OUT_* APDU for a tagged output and report the exact device response
 * length to expect, so the session orchestrator can length-check each reply.
 */
export function buildClearSignOutput(
  output: ClearSignOutput,
  profile: ApduProfile = RAILGUN_PROFILE,
): { readonly command: ApduCommand; readonly responseLength: number } {
  switch (output.kind) {
    case 'broadcaster':
      return { command: buildClearSignOutBroadcaster(output, profile), responseLength: CLEAR_SIGN_OUTPUT_TUPLE_RESPONSE_LENGTH };
    case 'change':
      return { command: buildClearSignOutChange(output, profile), responseLength: CLEAR_SIGN_OUTPUT_TUPLE_RESPONSE_LENGTH };
    case 'transfer':
      return { command: buildClearSignOutTransfer(output, profile), responseLength: CLEAR_SIGN_TRANSFER_RESPONSE_LENGTH };
    case 'unshield':
      return { command: buildClearSignOutUnshield(output, profile), responseLength: CLEAR_SIGN_UNSHIELD_RESPONSE_LENGTH };
  }
}

/** A single-tx CLEAR_SIGN transact to sign (n inputs, m outputs). */
export type ClearSignTransactRequest = {
  readonly account?: number;
  /** 32-byte merkle root. */
  readonly merkleRoot: Uint8Array;
  /** One 32-byte nullifier per input (1..3). */
  readonly nullifiers: readonly Uint8Array[];
  /** Bound-params fields (tree, minGasPrice, unshield, chainID, adapt*). */
  readonly boundParams: ClearSignBpFieldsRequest;
  /** Outputs (1..3), sent in array order. */
  readonly outputs: readonly ClearSignOutput[];
};

/** The raw device response for one streamed output (opaque ciphertext material). */
export type ClearSignOutputResult = {
  readonly kind: ClearSignOutput['kind'];
  readonly response: Uint8Array;
};

/** Structured decode of a broadcaster/change/transfer OUT_* response (the 208-byte tuple + trailers). */
export type ClearSignDecodedTuple = {
  readonly random: Uint8Array; // 16
  /** Blind1 — sender blinding key (32). */
  readonly senderBlindingKey: Uint8Array;
  /** Blind2 — recipient blinding key (32). */
  readonly recipientBlindingKey: Uint8Array;
  readonly iv: Uint8Array; // 16
  readonly tag: Uint8Array; // 16
  readonly ciphertext: Uint8Array; // 96
  readonly senderRandom: Uint8Array; // 15
  /** Present only for OUT_TRANSFER (16). */
  readonly annotationIv?: Uint8Array;
};

/** A decoded OUT_* response: a note tuple, or an unshield commitment. */
export type ClearSignDecodedOutput =
  | ({ readonly kind: 'broadcaster' | 'change' | 'transfer' } & ClearSignDecodedTuple)
  | { readonly kind: 'unshield'; readonly commitment: Uint8Array };

/**
 * Decode a raw OUT_* device response into its structured fields, using the byte
 * layout the firmware author's reference (`clear-sign-apdus.js`) documents:
 *   tuple(208) = random(16) ‖ Blind1(32) ‖ Blind2(32) ‖ IV(16) ‖ tag(16) ‖ ciphertext(96)
 *   + senderRandom(15)  [+ annotationIv(16) for transfer];  unshield = commitment(32).
 * These fields are what the RAILGUN engine assembles into the on-chain transact
 * calldata (that assembly is protocol/ABI-specific and lives in the engine).
 */
export function decodeClearSignOutput(result: ClearSignOutputResult): ClearSignDecodedOutput {
  const { kind, response } = result;
  if (kind === 'unshield') {
    assertBytes(response, CLEAR_SIGN_UNSHIELD_RESPONSE_LENGTH, 'OUT_UNSHIELD response');
    return { kind, commitment: response.slice() };
  }
  const expected = kind === 'transfer'
    ? CLEAR_SIGN_TRANSFER_RESPONSE_LENGTH
    : CLEAR_SIGN_OUTPUT_TUPLE_RESPONSE_LENGTH;
  assertBytes(response, expected, `OUT_${kind} response`);
  const tuple = {
    kind,
    random: response.slice(0, 16),
    senderBlindingKey: response.slice(16, 48),
    recipientBlindingKey: response.slice(48, 80),
    iv: response.slice(80, 96),
    tag: response.slice(96, 112),
    ciphertext: response.slice(112, 208),
    senderRandom: response.slice(208, 223),
  } as const;
  return kind === 'transfer' ? { ...tuple, annotationIv: response.slice(223, 239) } : tuple;
}

// ─── Multi-tx (txToken ≠ feeToken) ────────────────────────────────────────────

/** One sub-transaction within a multi-tx CLEAR_SIGN session. */
export type ClearSignSubTransact = {
  readonly merkleRoot: Uint8Array;
  readonly nullifiers: readonly Uint8Array[];
  readonly boundParams: ClearSignBpFieldsRequest;
  readonly outputs: readonly ClearSignOutput[];
};

/**
 * A multi-tx CLEAR_SIGN transact — the txToken ≠ feeToken case bundles two
 * sub-transactions (value transfer in token A + broadcaster fee in token B),
 * each with its own nullifiers / bound-params / outputs, signed together.
 */
export type ClearSignMultiTransactRequest = {
  readonly account?: number;
  /** 15-byte wallet-source tag; defaults to all-zero. */
  readonly walletSource?: Uint8Array;
  /** The sub-transactions (nTx ≥ 2 for the multi flow). */
  readonly transactions: readonly ClearSignSubTransact[];
};

/**
 * CS_INIT multi-tx (P1 0x00):
 * account(4) ‖ nTx(1) ‖ walletSource(15) ‖ [merkleRoot(32) ‖ nIn(1) ‖ nOut(1)] × nTx.
 */
export function buildClearSignInitMultiTx(
  request: ClearSignMultiTransactRequest,
  profile: ApduProfile = RAILGUN_PROFILE,
): ApduCommand {
  const nTx = request.transactions.length;
  // Device caps a multi-tx session at CS_MAX_TXS = 2 (txToken != feeToken).
  if (!Number.isInteger(nTx) || nTx < 1 || nTx > 2) {
    throw new Error(`CLEAR_SIGN multi-tx supports 1..2 transactions, got ${String(nTx)}`);
  }
  const walletSource = request.walletSource ?? new Uint8Array(15);
  assertBytes(walletSource, 15, 'CLEAR_SIGN walletSource');
  const perTx = request.transactions.map((tx) => {
    assertBytes(tx.merkleRoot, 32, 'CLEAR_SIGN merkleRoot');
    validateClearSignShape(tx.nullifiers.length, tx.outputs.length);
    return concatBytes(tx.merkleRoot, new Uint8Array([tx.nullifiers.length, tx.outputs.length]));
  });
  const data = concatBytes(
    encodeAccountIndex(request.account ?? 0),
    new Uint8Array([nTx]),
    walletSource,
    ...perTx,
  );
  return { cla: profile.cla, ins: clearSignIns(profile), p1: ClearSignP1.INIT, p2: 0, data };
}

function encodeAscii127(value: string): Uint8Array {
  const out = new Uint8Array(127);
  if (value.length !== 127) {
    throw new Error(`0zk recipient must be exactly 127 characters, got ${String(value.length)}`);
  }
  for (let i = 0; i < 127; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) {
      throw new Error(`0zk recipient contains a non-printable-ASCII character at index ${String(i)}`);
    }
    out[i] = code;
  }
  return out;
}
