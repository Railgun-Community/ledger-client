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

import type { HWTransport } from '../transport/types.js';
import type { Signature } from '../connector/types.js';
import type { ApduProfile, RailgunAppCapabilities } from '../transport/apdu-profile.js';
import { RAILGUN_PROFILE } from '../transport/apdu-profile.js';
import {
  buildGetPublicKey,
  buildSignHash,
  buildGetViewingKey,
  buildRailgunEip7702Bip32Path,
  buildRailgunEthereumBip32Path,
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
  extractEchoedHash,
} from '../../validation/apdu-response.js';
import { validateSignature } from '../../validation/signature.js';
import { HWError, HWErrorCode } from '../errors.js';
import {
  deriveRailgunWalletArtifacts,
  type RailgunWalletArtifacts,
} from '../wallet-artifacts.js';

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

  private assertSessionChainId(session: RailgunEthereumSignerSession | undefined, chainId: bigint): void {
    if (session !== undefined && session.chainId !== chainId) {
      throw new HWError(
        HWErrorCode.VALIDATION_DERIVATION_INDEX,
        `Prepared Ethereum signer chainId ${String(session.chainId)} does not match request chainId ${String(chainId)}.`,
      );
    }
  }

  async signEip7702Authorization(request: Eip7702AuthorizationRequest): Promise<EthereumSignatureParts> {
    this.requireCapability(
      (capabilities) => capabilities.eip7702Authorization,
      'RAILGUN app does not advertise EIP-7702 authorization signing support.',
    );
    this.assertSessionChainId(request.session, request.chainId);
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
