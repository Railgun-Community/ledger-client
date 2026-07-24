/**
 * RAILGUN Signer.
 *
 * Sends custom APDU commands to the RAILGUN Ledger app
 * for BabyJubjub EdDSA operations:
 * - GET_PUBLIC_KEY (0x01) — retrieve spending public key for an account
 * - SIGN_HASH (0x12) — sign a poseidon hash (with on-device display)
 * - GET_VIEWING_KEY (0x13) — retrieve viewing private key for an account
 *
 * Trust boundary: validates all device responses before returning.
 * Does NOT manage transport lifecycle — caller is responsible for
 * connecting/disconnecting.
 */

import type { HWTransport, ApduCommand } from '../transport/types.js';
import type { Signature } from '../connector/types.js';
import type { ApduProfile, RailgunAppCapabilities } from '../transport/apdu-profile.js';
import { RAILGUN_PROFILE } from '../transport/apdu-profile.js';
import {
  buildClearSignInit,
  buildClearSignNullifier,
  buildClearSignBpFields,
  buildClearSignOutput,
  buildClearSignFinalize,
  buildClearSignInitMultiTx,
  validateClearSignShape,
  type ClearSignTransactRequest,
  type ClearSignMultiTransactRequest,
  type ClearSignOutputResult,
} from '../transport/clear-sign-apdu.js';
import {
  buildGetPublicKey,
  buildSignHash,
  buildGetViewingKey,
  buildGetViewingPublicKey,
  buildGetRailgunAddress,
  buildRailgunEip7702Bip32Path,
  buildRailgunEthereumBip32Path,
  encodeRailgunEthereumPathSuffixFromBip32Path,
  buildGetEthereumPublicKey,
  buildSignEip7702Authorization,
  buildSignEthereumTxHash,
  parseEthereumSignatureResponse,
  type EthereumSignatureParts,
  type RailgunEthereumPathRequest,
} from '../transport/apdu.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import {
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
} from '../../validation/apdu-response.js';
import { validateSignature } from '../../validation/signature.js';
import { HWError, HWErrorCode } from '../errors.js';
import {
  deriveRailgunWalletArtifacts,
  type RailgunWalletArtifacts,
} from '../wallet-artifacts.js';
import {
  createRailgunRelayAdapt7702HookedSignerFromRailgunSigner,
  type Railgun7702Signer,
  type Railgun7702SignerRequest,
  type RailgunRelayAdapt7702SignerOptions,
} from '../../sdk/engine/railgun-7702-hooked-signer.js';

/**
 * Convert a bigint to a 32-byte little-endian Uint8Array.
 * LSB at bytes[0]; matches the Ed25519/circomlibjs convention the
 * on-device app uses when decoding the SIGN_HASH payload into a
 * field element for the Poseidon EdDSA challenge.
 * Throws if the value requires more than 32 bytes.
 */
function bigintTo32BytesLE(value: bigint): Uint8Array {
  if (value < 0n) {
    throw new HWError(
      HWErrorCode.VALIDATION_HASH,
      'Hash must be non-negative',
    );
  }
  const bytes = new Uint8Array(32);
  let v = value;
  for (let i = 0; i < 32; i++) {
    bytes[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  if (v !== 0n) {
    throw new HWError(
      HWErrorCode.VALIDATION_HASH,
      'Hash exceeds 32 bytes',
    );
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function defaultCapabilities(): RailgunAppCapabilities {
  return {
    ethereumAddress: false,
    eip7702Authorization: false,
    ethereumTxHash: false,
    ethereumSigning: [],
    viewingPublicKey: false,
    railgunAddress: false,
    railgunClearSign: false,
  };
}

export type RailgunSignerConfig = {
  readonly transport: HWTransport;
  /** Account index for key derivation (default 0). */
  readonly account?: number;
  /** APDU profile — defaults to RAILGUN_PROFILE. */
  readonly profile?: ApduProfile;
};

export type RailgunEthereumAddressResult = {
  readonly address: string;
  readonly publicKey: string;
};

export type RailgunEthereumPreloadRequest = RailgunEthereumPathRequest & {
  readonly displayAddress?: boolean;
};

export type RailgunEthereumSignerSession = RailgunEthereumPathRequest & RailgunEthereumAddressResult & {
  readonly chainId: bigint;
  readonly path: readonly number[];
  readonly capabilities: RailgunAppCapabilities;
};

export type Eip7702AuthorizationRequest = {
  readonly chainId: bigint;
  readonly contractAddress: Uint8Array;
  readonly nonce: bigint;
  readonly path?: readonly number[];
  readonly session?: RailgunEthereumSignerSession;
};

export type EthereumTxHashSignOptions = {
  readonly display?: boolean;
  readonly path?: readonly number[];
  readonly session?: RailgunEthereumSignerSession;
  /**
   * Explicit opt-in required to blind-sign (display: false). Without it, a
   * display:false request is rejected — the device would otherwise sign a
   * 32-byte digest with no on-screen context. Prefer clear signing.
   */
  readonly allowBlind?: boolean;
};

/** Result of a CLEAR_SIGN transact: the EdDSA signature, the echoed message hash, and the raw per-output responses. */
export type ClearSignTransactResult = {
  readonly signature: Signature;
  readonly msgHash: Uint8Array;
  readonly outputs: readonly ClearSignOutputResult[];
};

/** Result of a multi-tx CLEAR_SIGN transact: one signature per tx (same key), plus all output responses in order. */
export type ClearSignMultiTransactResult = {
  readonly signatures: ReadonlyArray<{ readonly signature: Signature; readonly msgHash: Uint8Array }>;
  readonly outputs: readonly ClearSignOutputResult[];
};

/**
 * RAILGUN signer — sends custom APDU commands to the RAILGUN Ledger app.
 *
 * The app derives keys internally from the device seed + account index.
 * No explicit deriveSeed step is needed.
 *
 * Lifecycle:
 * 1. Create signer with transport reference + optional account index
 * 2. Call getPublicKey() / getWalletArtifacts() / sign() as needed
 *
 * Transport must be connected and RAILGUN app must be open before use.
 */
export class RailgunSigner {
  private readonly transport: HWTransport;
  private readonly account: number;
  private readonly profile: ApduProfile;

  constructor(config: RailgunSignerConfig) {
    this.transport = config.transport;
    this.account = config.account ?? 0;
    this.profile = config.profile ?? RAILGUN_PROFILE;
  }

  getCapabilities(): RailgunAppCapabilities {
    return this.profile.capabilities ?? defaultCapabilities();
  }

  private requireCapability(
    predicate: (capabilities: RailgunAppCapabilities) => boolean,
    message: string,
  ): void {
    if (!predicate(this.getCapabilities())) {
      throw new HWError(HWErrorCode.APP_VERSION_MISMATCH, message);
    }
  }

  /**
   * Get the BabyJubjub spending public key from the device.
   * @returns Affine point (x, y) as bigints.
   */
  async getPublicKey(): Promise<{ readonly x: bigint; readonly y: bigint }> {
    const response = await this.transport.send(buildGetPublicKey(this.account, this.profile));
    validateApduResponse(response);
    return parsePublicKeyResponse(response.data);
  }

  private async getViewingKeyBytes(): Promise<Uint8Array> {
    const response = await this.transport.send(buildGetViewingKey(this.account, this.profile));
    validateApduResponse(response);
    return parseViewingKeyResponse(response.data);
  }

  /**
    * Derive the wallet artifacts needed for wallet loading.
    * The returned shareable viewing key remains sensitive because it embeds the
    * viewing secret required by the current engine format.
   * Requires user confirmation on the device display.
   */
  async getWalletArtifacts(): Promise<RailgunWalletArtifacts> {
    const spendingPublicKey = await this.getPublicKey();
    const viewingPrivateKey = await this.getViewingKeyBytes();
    return deriveRailgunWalletArtifacts(spendingPublicKey, viewingPrivateKey);
  }

  /**
   * Get the compressed Ed25519 viewing *public* key from the device (INS 0x10).
   * Display/verify accessor — requires an on-device confirmation and does NOT
   * export the viewing secret. Wallet loading still uses `getWalletArtifacts()`.
   * @returns 32 raw bytes (compressed Ed25519 point).
   */
  async getViewingPublicKey(): Promise<Uint8Array> {
    this.requireCapability(
      (capabilities) => capabilities.viewingPublicKey,
      'RAILGUN app does not advertise viewing-public-key retrieval support.',
    );
    const response = await this.transport.send(buildGetViewingPublicKey(this.account, this.profile));
    validateApduResponse(response);
    return parseViewingPublicKeyResponse(response.data);
  }

  /**
   * Derive and display the canonical `0zk1…` address on the device (INS 0x14).
   * Device-confirmed cross-check of the host-derived address — requires an
   * on-device confirmation.
   * @returns the 127-character `0zk1…` address string.
   */
  async getRailgunAddress(): Promise<string> {
    this.requireCapability(
      (capabilities) => capabilities.railgunAddress,
      'RAILGUN app does not advertise RAILGUN-address derivation support.',
    );
    const response = await this.transport.send(buildGetRailgunAddress(this.account, this.profile));
    validateApduResponse(response);
    return parseRailgunAddressResponse(response.data);
  }

  private async sendClearSignStep(command: ApduCommand): Promise<void> {
    const response = await this.transport.send(command);
    validateApduResponse(response);
  }

  /**
   * Clear-sign a RAILGUN transact (INS 0x11). Streams the session in order —
   * CS_INIT → NULLIFIER×n → BP_FIELDS → OUT_*×m → FINALIZE — collecting each
   * output's opaque device response, then parses the FINALIZE signature. The
   * device shows the actual recipients/tokens/amounts and signs on approval.
   *
   * Returns the EdDSA signature, the echoed message hash, and the raw per-output
   * responses (which the caller splices into the on-chain transact calldata).
   * Experimental — see `CAPABILITY_STATUS.clearSign`.
   */
  async signClearSignTransact(request: ClearSignTransactRequest): Promise<ClearSignTransactResult> {
    this.requireCapability(
      (capabilities) => capabilities.railgunClearSign,
      'RAILGUN app does not advertise CLEAR_SIGN transact support.',
    );
    const nIn = request.nullifiers.length;
    const nOut = request.outputs.length;
    validateClearSignShape(nIn, nOut);
    const account = request.account ?? this.account;

    // Pre-build the whole session first: every builder validates its field widths
    // and ranges, so any illegal input throws BEFORE the first APDU is sent and
    // never opens a session on the stateful device.
    const initCommand = buildClearSignInit({ account, merkleRoot: request.merkleRoot, nIn, nOut }, this.profile);
    const nullifierCommands = request.nullifiers.map((nullifier) => buildClearSignNullifier(nullifier, this.profile));
    const bpCommand = buildClearSignBpFields(request.boundParams, this.profile);
    const outputPlan = request.outputs.map((output) => ({ kind: output.kind, ...buildClearSignOutput(output, this.profile) }));
    const finalizeCommand = buildClearSignFinalize(this.profile);

    await this.sendClearSignStep(initCommand);
    for (const command of nullifierCommands) {
      await this.sendClearSignStep(command);
    }
    await this.sendClearSignStep(bpCommand);

    const outputs: ClearSignOutputResult[] = [];
    for (const { kind, command, responseLength } of outputPlan) {
      const response = await this.transport.send(command);
      validateApduResponse(response);
      outputs.push({ kind, response: parseClearSignOutputResponse(response.data, responseLength, `OUT_${kind}`) });
    }

    const finalizeResponse = await this.transport.send(finalizeCommand);
    validateApduResponse(finalizeResponse);
    const { signature, msgHash } = parseClearSignFinalize(finalizeResponse.data);
    validateSignature(signature);
    return { signature, msgHash, outputs };
  }

  /**
   * Clear-sign a multi-tx transact (txToken ≠ feeToken). Sends the multi-tx
   * CS_INIT, then streams each sub-transaction (NULLIFIER×n → BP_FIELDS →
   * OUT_*×m) in order, and parses the combined FINALIZE into one signature per
   * transaction (all under the same key). Experimental — see
   * `CAPABILITY_STATUS.clearSign`.
   */
  async signClearSignMultiTransact(request: ClearSignMultiTransactRequest): Promise<ClearSignMultiTransactResult> {
    this.requireCapability(
      (capabilities) => capabilities.railgunClearSign,
      'RAILGUN app does not advertise CLEAR_SIGN transact support.',
    );
    const txCount = request.transactions.length;
    if (txCount < 2) {
      throw new Error(`CLEAR_SIGN multi-tx requires at least 2 transactions, got ${String(txCount)}. Use signClearSignTransact for a single tx.`);
    }
    for (const tx of request.transactions) {
      validateClearSignShape(tx.nullifiers.length, tx.outputs.length);
    }

    // Pre-build the whole multi-tx session (the multi CS_INIT also enforces nTx <= 2
    // and each sub-tx's field widths) so any illegal input throws before any APDU.
    const initCommand = buildClearSignInitMultiTx({ ...request, account: request.account ?? this.account }, this.profile);
    const txPlans = request.transactions.map((tx) => ({
      nullifierCommands: tx.nullifiers.map((nullifier) => buildClearSignNullifier(nullifier, this.profile)),
      bpCommand: buildClearSignBpFields(tx.boundParams, this.profile),
      outputPlan: tx.outputs.map((output) => ({ kind: output.kind, ...buildClearSignOutput(output, this.profile) })),
    }));
    const finalizeCommand = buildClearSignFinalize(this.profile);

    await this.sendClearSignStep(initCommand);
    const outputs: ClearSignOutputResult[] = [];
    for (const plan of txPlans) {
      for (const command of plan.nullifierCommands) {
        await this.sendClearSignStep(command);
      }
      await this.sendClearSignStep(plan.bpCommand);
      for (const { kind, command, responseLength } of plan.outputPlan) {
        const response = await this.transport.send(command);
        validateApduResponse(response);
        outputs.push({ kind, response: parseClearSignOutputResponse(response.data, responseLength, `OUT_${kind}`) });
      }
    }

    const finalizeResponse = await this.transport.send(finalizeCommand);
    validateApduResponse(finalizeResponse);
    const signatures = parseClearSignFinalizeMulti(finalizeResponse.data, txCount);
    for (const { signature } of signatures) validateSignature(signature);
    return { signatures, outputs };
  }

  private async getEthereumPublicKeyAtPath(request: RailgunEthereumPreloadRequest, display: boolean): Promise<Uint8Array> {
    this.requireCapability(
      (capabilities) => capabilities.ethereumAddress,
      'RAILGUN app does not advertise Ethereum address derivation support.',
    );
    const response = await this.transport.send(buildGetEthereumPublicKey(request, display, this.profile));
    validateApduResponse(response);
    if (response.data.length !== 65 || response.data[0] !== 0x04) {
      throw new HWError(
        HWErrorCode.APDU_INVALID_RESPONSE,
        `Invalid Ethereum public key response length: ${String(response.data.length)} bytes.`,
      );
    }
    return response.data;
  }

  async getEthereumPublicKey(display = false): Promise<Uint8Array> {
    return this.getEthereumPublicKeyAtPath({
      railgunAccountIndex: this.account,
      chainId: 0,
      ephemeralIndex: 0,
    }, display);
  }

  private ethereumAddressFromPublicKey(publicKey: Uint8Array): RailgunEthereumAddressResult {
    const digest = keccak_256(publicKey.slice(1));
    const address = `0x${bytesToHex(digest.slice(-20))}`;
    return { address, publicKey: `0x${bytesToHex(publicKey)}` };
  }

  async getEthereumAddress(display = false): Promise<RailgunEthereumAddressResult> {
    const publicKey = await this.getEthereumPublicKey(display);
    return this.ethereumAddressFromPublicKey(publicKey);
  }

  async prepareEthereumSigner(request: RailgunEthereumPreloadRequest): Promise<RailgunEthereumSignerSession> {
    const path = buildRailgunEthereumBip32Path(request);
    const publicKey = await this.getEthereumPublicKeyAtPath(
      request,
      request.displayAddress ?? false,
    );
    return {
      railgunAccountIndex: request.railgunAccountIndex,
      chainId: BigInt(request.chainId),
      ephemeralIndex: request.ephemeralIndex,
      path,
      ...this.ethereumAddressFromPublicKey(publicKey),
      capabilities: this.getCapabilities(),
    };
  }

  async get7702Signer(
    request: Railgun7702SignerRequest,
    options: RailgunRelayAdapt7702SignerOptions = {},
  ): Promise<Railgun7702Signer> {
    return createRailgunRelayAdapt7702HookedSignerFromRailgunSigner(
      this,
      {
        railgunWalletID: 'railgun-signer',
        railgunAccountIndex: request.railgunAccountIndex ?? this.account,
        chainId: BigInt(request.chainId),
        ephemeralIndex: request.ephemeralIndex,
      },
      options,
    );
  }

  private assertSessionChainId(session: RailgunEthereumSignerSession | undefined, chainId: bigint): void {
    if (session !== undefined && session.chainId !== chainId) {
      throw new HWError(
        HWErrorCode.VALIDATION_DERIVATION_INDEX,
        `Prepared Ethereum signer chainId ${String(session.chainId)} does not match request chainId ${String(chainId)}.`,
      );
    }
  }

  /**
   * Chain-scoping guard for an explicitly-supplied path: the EOA is derived from
   * the path (whose word W1 is the chainId), and the authorization is signed
   * against the same chainId in the 8-byte field. Reject an explicit `path` whose
   * W1 disagrees with the authorization chainId — otherwise a caller could derive
   * one chain's EOA but authorize on another, defeating chain-scoping. Session and
   * fallback paths are built from the chainId, so they always match; only an
   * explicit `path` can diverge, so that is the only case guarded here.
   */
  private assertPathChainId(path: readonly number[], chainId: bigint): void {
    const suffix = encodeRailgunEthereumPathSuffixFromBip32Path(path);
    const pathChainId = BigInt(new DataView(suffix.buffer, suffix.byteOffset, suffix.byteLength).getUint32(4, false));
    if (pathChainId !== chainId) {
      throw new HWError(
        HWErrorCode.VALIDATION_DERIVATION_INDEX,
        `7702 derivation path chainId (W1=${String(pathChainId)}) does not match the authorization chainId (${String(chainId)}).`,
      );
    }
  }

  async signEip7702Authorization(request: Eip7702AuthorizationRequest): Promise<EthereumSignatureParts> {
    this.requireCapability(
      (capabilities) => capabilities.eip7702Authorization,
      'RAILGUN app does not advertise EIP-7702 authorization signing support.',
    );
    this.assertSessionChainId(request.session, request.chainId);
    if (request.path !== undefined) {
      this.assertPathChainId(request.path, request.chainId);
    }
    const response = await this.transport.send(buildSignEip7702Authorization({
      ...request,
      path: request.path ?? request.session?.path ?? buildRailgunEthereumBip32Path({
        railgunAccountIndex: this.account,
        chainId: request.chainId,
        ephemeralIndex: 0,
      }),
    }, this.profile));
    validateApduResponse(response);
    try {
      return parseEthereumSignatureResponse(response.data);
    } catch (error) {
      throw new HWError(HWErrorCode.SIGN_INVALID_RESPONSE, 'Invalid EIP-7702 signature response.', error);
    }
  }

  async signEthereumTxHash(
    hash: Uint8Array,
    options: EthereumTxHashSignOptions = {},
  ): Promise<EthereumSignatureParts> {
    const display = options.display ?? true;
    if (!display && options.allowBlind !== true) {
      throw new HWError(
        HWErrorCode.SIGN_BLIND_NOT_ALLOWED,
        'Blind Ethereum signing (display: false) requires an explicit allowBlind: true opt-in. Prefer clear signing (display: true).',
      );
    }
    this.requireCapability(
      (capabilities) => capabilities.ethereumTxHash,
      'RAILGUN app does not advertise Ethereum tx-hash signing support.',
    );
    this.requireCapability(
      (capabilities) => capabilities.ethereumSigning.includes(display ? 'clear' : 'blind'),
      `RAILGUN app does not advertise ${display ? 'clear' : 'blind'} Ethereum signing support.`,
    );

    const response = await this.transport.send(
      buildSignEthereumTxHash(
        hash,
        display,
        options.path ?? options.session?.path ?? buildRailgunEip7702Bip32Path(this.account),
        this.profile,
      ),
    );
    validateApduResponse(response);
    try {
      return parseEthereumSignatureResponse(response.data);
    } catch (error) {
      throw new HWError(HWErrorCode.SIGN_INVALID_RESPONSE, 'Invalid Ethereum tx-hash signature response.', error);
    }
  }

  /**
   * Sign a poseidon hash with the device's BabyJubjub private key.
   * The hash is displayed on the device for user confirmation.
   *
   * @param hash - Poseidon hash as bigint (serialized to 32 bytes little-endian
   *   to match the on-device Ed25519/circomlibjs byte → field decoding)
   * @returns BabyJubjub EdDSA signature {R8: [x, y], S}
   * @throws HWError on invalid hash, device rejection, or invalid signature
   */
  async sign(hash: bigint): Promise<Signature> {
    const hashBytes = bigintTo32BytesLE(hash);
    const response = await this.transport.send(buildSignHash(hashBytes, this.account, this.profile));
    validateApduResponse(response);

    const signature = parseSignResponse(response.data, this.profile.commands.sign.hasPrefix);

    // Verify echoed hash matches what we sent (tamper detection)
    if (this.profile.commands.sign.echoesHash) {
      const echoed = extractEchoedHash(response.data, this.profile.commands.sign.hasPrefix);
      if (echoed !== null) {
        let mismatch = false;
        if (echoed.length !== hashBytes.length) {
          mismatch = true;
        } else {
          for (let i = 0; i < echoed.length; i++) {
            if (echoed[i] !== hashBytes[i]) {
              mismatch = true;
              break;
            }
          }
        }
        if (mismatch) {
          throw new HWError(
            HWErrorCode.SIGN_INVALID_RESPONSE,
            'Device echoed hash does not match the hash that was sent',
          );
        }
      }
    }

    // Post-signing validation: ensure signature is in valid field/subgroup
    validateSignature(signature);

    return signature;
  }
}
