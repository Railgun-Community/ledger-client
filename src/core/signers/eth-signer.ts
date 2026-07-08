/**
 * ETH Signer — wraps @ledgerhq/hw-app-eth.
 *
 * Provides Ethereum signing operations via the standard Ledger Ethereum app.
 * Supports:
 * - Transaction signing (raw hex)
 * - Personal message signing
 * - EIP-712 typed data signing
 *
 * Requires the Ethereum app to be open on the device.
 *
 * Note: The Ledger SDK apps bundle their own copy of @ledgerhq/hw-transport
 * which may have slightly different optional-property types. Our adapter
 * extends the top-level @ledgerhq/hw-transport Transport, so a single checked
 * `as EthAppTransport` bridges to the constructor parameter type the app
 * expects (no `as unknown` double-cast — TS still verifies structural overlap).
 */

import type { HWTransport } from '../transport/types.js';
import type {
  EthSignResult,
  EthTxSignRequest,
  EthMessageSignRequest,
  EthTypedDataSignRequest,
} from './types.js';
import { createLedgerTransportAdapter } from '../transport/ledger-transport-adapter.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { HWError, HWErrorCode } from '../errors.js';

export const RAILGUN_SHIELD_MESSAGE = 'RAILGUN_SHIELD' as const;

export type ShieldOwnershipMarkerResult = {
  readonly type: 'eth_shield';
  readonly message: typeof RAILGUN_SHIELD_MESSAGE;
  readonly derivationIndex: number;
  readonly derivationPath: string;
  readonly signatureHex: string;
  readonly v: number;
  readonly r: string;
  readonly s: string;
};

export type HwSignShieldResult = ShieldOwnershipMarkerResult;

/**
 * Dynamically import the Ledger ETH app.
 * The import is deferred to avoid bundling it when unused.
 */
async function getEthApp(): Promise<typeof import('@ledgerhq/hw-app-eth').default> {
  const mod = await import('@ledgerhq/hw-app-eth');
  return mod.default;
}

type EthAppClass = typeof import('@ledgerhq/hw-app-eth').default;
type EthAppTransport = ConstructorParameters<EthAppClass>[0];

/**
 * Adapt our transport to the type expected by hw-app-eth.
 * The Ledger SDK bundles its own copy of @ledgerhq/hw-transport with
 * slightly different optional property types. The runtime shape is identical,
 * so we bridge to the exact constructor parameter type the app expects.
 */
function adaptTransport(transport: HWTransport): EthAppTransport {
  return createLedgerTransportAdapter(transport) as EthAppTransport;
}

function normalizeV(value: number | string): number {
  if (typeof value === 'number') {
    return value;
  }

  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10);
  }

  const hex = trimmed.startsWith('0x') ? trimmed.slice(2) : trimmed;
  return Number.parseInt(hex, 16);
}

function normalizeHexComponent(value: string, label: string): string {
  const normalized = value.startsWith('0x') ? value.slice(2) : value;
  if (normalized.length === 0 || normalized.length % 2 !== 0 || /[^0-9a-f]/i.test(normalized)) {
    throw new HWError(HWErrorCode.SIGN_INVALID_RESPONSE, `Invalid ${label} component returned by Ethereum app.`);
  }
  return normalized.toLowerCase();
}

function toSignatureHex(result: Pick<EthSignResult, 'v' | 'r' | 's'>): string {
  const recovery = normalizeV(result.v);
  if (!Number.isInteger(recovery) || recovery < 0 || recovery > 255) {
    throw new HWError(HWErrorCode.SIGN_INVALID_RESPONSE, 'Ethereum app returned an invalid recovery parameter.');
  }
  const r = normalizeHexComponent(result.r, 'r');
  const s = normalizeHexComponent(result.s, 's');
  return `0x${r}${s}${recovery.toString(16).padStart(2, '0')}`;
}

export function buildEthereumAccountDerivationPath(derivationIndex: number): string {
  if (!Number.isSafeInteger(derivationIndex) || derivationIndex < 0 || derivationIndex > 0x7fffffff) {
    throw new HWError(
      HWErrorCode.VALIDATION_DERIVATION_INDEX,
      `Invalid Ethereum derivation index: ${String(derivationIndex)}. Expected a safe integer in [0, 2147483647].`,
    );
  }

  return `m/44'/60'/0'/0/${String(derivationIndex)}`;
}

export type EthSignerConfig = {
  readonly transport: HWTransport;
};

export class EthSigner {
  private readonly transport: HWTransport;

  constructor(config: EthSignerConfig) {
    this.transport = config.transport;
  }

  /**
   * Get an Ethereum address for a BIP-32 path.
   */
  async getAddress(
    path: string,
    display = false,
  ): Promise<{ readonly address: string; readonly publicKey: string }> {
    const EthApp = await getEthApp();
    const adapter = adaptTransport(this.transport);
    const eth = new EthApp(adapter);
    const result = await eth.getAddress(path, display);
    return { address: result.address, publicKey: result.publicKey };
  }

  /**
   * Get the standard EOA address at a derivation index.
   *
   * `display` defaults to `false` — the device returns the derived address
   * silently with no user confirmation. Callers that want the user to
   * confirm the address visually on the device (e.g. before sending funds)
   * should pass `display: true`.
   */
  async getAddressAtIndex(
    derivationIndex: number,
    display = false,
  ): Promise<{ readonly address: string; readonly publicKey: string }> {
    return this.getAddress(
      buildEthereumAccountDerivationPath(derivationIndex),
      display,
    );
  }

  /**
   * Sign a raw Ethereum transaction.
   */
  async signTransaction(request: EthTxSignRequest): Promise<EthSignResult> {
    const EthApp = await getEthApp();
    const adapter = adaptTransport(this.transport);
    const eth = new EthApp(adapter);

    const result = await eth.signTransaction(
      request.derivationPath,
      request.rawTxHex,
      null, // blind signing — no resolution
    );

    return {
      type: 'eth',
      v: normalizeV(result.v),
      r: `0x${result.r}`,
      s: `0x${result.s}`,
    };
  }

  async signTransactionAtIndex(
    rawTxHex: string,
    derivationIndex: number,
  ): Promise<EthSignResult> {
    return this.signTransaction({
      type: 'eth_tx',
      rawTxHex,
      derivationPath: buildEthereumAccountDerivationPath(derivationIndex),
    });
  }

  /**
   * Sign a personal message (EIP-191) at a derivation index.
   *
   * The Ledger ETH app's signPersonalMessage produces a recoverable
   * ECDSA signature deterministically (RFC-6979). This is the
   * primitive used for backend wallet-signature login flows.
   */
  async signPersonalMessageAtIndex(
    message: string | Uint8Array,
    derivationIndex: number,
  ): Promise<EthSignResult> {
    return this.signPersonalMessage({
      type: 'eth_message',
      message,
      derivationPath: buildEthereumAccountDerivationPath(derivationIndex),
    });
  }

  /**
   * Sign pre-hashed EIP-712 typed data at a derivation index.
   *
   * Accepts the hashed form (domain separator + struct hash) for
   * broadest Ledger ETH app version compatibility. Callers using
   * viem can compute these via `hashDomain` / `hashStruct`.
   */
  async signTypedDataAtIndex(
    payload: { readonly domainSeparatorHex: string; readonly hashStructMessageHex: string },
    derivationIndex: number,
  ): Promise<EthSignResult> {
    return this.signTypedData({
      type: 'eth_typed_data',
      domainSeparatorHex: payload.domainSeparatorHex,
      hashStructMessageHex: payload.hashStructMessageHex,
      derivationPath: buildEthereumAccountDerivationPath(derivationIndex),
    });
  }

  /**
   * Sign a personal message (EIP-191).
   */
  async signPersonalMessage(request: EthMessageSignRequest): Promise<EthSignResult> {
    const EthApp = await getEthApp();
    const adapter = adaptTransport(this.transport);
    const eth = new EthApp(adapter);

    const messageHex = typeof request.message === 'string'
      ? bytesToHex(new TextEncoder().encode(request.message))
      : bytesToHex(new Uint8Array(request.message));

    const result = await eth.signPersonalMessage(
      request.derivationPath,
      messageHex,
    );

    return {
      type: 'eth',
      v: normalizeV(result.v),
      r: `0x${result.r}`,
      s: `0x${result.s}`,
    };
  }

  async signShieldOwnershipMarker(
    derivationIndex: number,
  ): Promise<ShieldOwnershipMarkerResult> {
    const derivationPath = buildEthereumAccountDerivationPath(derivationIndex);
    const signature = await this.signPersonalMessage({
      type: 'eth_message',
      derivationPath,
      message: RAILGUN_SHIELD_MESSAGE,
    });

    return {
      type: 'eth_shield',
      message: RAILGUN_SHIELD_MESSAGE,
      derivationIndex,
      derivationPath,
      signatureHex: toSignatureHex(signature),
      v: signature.v,
      r: signature.r,
      s: signature.s,
    };
  }

  async hwSignShield(
    derivationIndex: number,
  ): Promise<HwSignShieldResult> {
    return this.signShieldOwnershipMarker(derivationIndex);
  }

  /**
   * Sign EIP-712 typed data.
   */
  async signTypedData(request: EthTypedDataSignRequest): Promise<EthSignResult> {
    const EthApp = await getEthApp();
    const adapter = adaptTransport(this.transport);
    const eth = new EthApp(adapter);

    const result = await eth.signEIP712HashedMessage(
      request.derivationPath,
      request.domainSeparatorHex,
      request.hashStructMessageHex,
    );

    return {
      type: 'eth',
      v: normalizeV(result.v),
      r: `0x${result.r}`,
      s: `0x${result.s}`,
    };
  }
}
