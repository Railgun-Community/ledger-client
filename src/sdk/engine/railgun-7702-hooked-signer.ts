import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import type { EthereumSignatureParts } from '../../core/transport/apdu.js';
import type {
  Eip7702AuthorizationRequest,
  EthereumTxHashSignOptions,
  RailgunEthereumPreloadRequest,
  RailgunEthereumSignerSession,
} from '../../core/signers/railgun-signer.js';
import type { LedgerController } from '../controller/types.js';

export type RelayAdapt7702AuthorizationRequest = {
  readonly address: string;
  readonly chainId?: number | bigint | string;
  readonly nonce?: number | bigint | string;
};

export type RelayAdapt7702Authorization = {
  readonly address: string;
  readonly nonce: bigint;
  readonly chainId: bigint;
  readonly signature: {
    readonly yParity: number;
    readonly r: string;
    readonly s: string;
  };
};

export type RelayAdapt7702TypedDataDomain = {
  readonly name?: string;
  readonly version?: string;
  readonly chainId?: number | bigint | string;
  readonly verifyingContract?: string;
};

export type RelayAdapt7702TypedDataField = {
  readonly name: string;
  readonly type: string;
};

export type RelayAdapt7702TypedDataTypes = Record<string, readonly RelayAdapt7702TypedDataField[]>;

export type RelayAdapt7702TypedDataValue = Record<string, unknown>;

export type RailgunRelayAdapt7702HookedSigner = {
  readonly address: string;
  populateAuthorization(
    request: RelayAdapt7702AuthorizationRequest,
  ): Promise<RelayAdapt7702AuthorizationRequest>;
  authorize(
    request: RelayAdapt7702AuthorizationRequest,
  ): Promise<RelayAdapt7702Authorization>;
  signTypedData(
    domain: RelayAdapt7702TypedDataDomain,
    types: RelayAdapt7702TypedDataTypes,
    value: RelayAdapt7702TypedDataValue,
  ): Promise<string>;
};

export type Railgun7702Signer = RailgunRelayAdapt7702HookedSigner;

export type Railgun7702SignerRequest = {
  /** Path word W1 — chain-scopes the EOA (a distinct address per chain). */
  readonly chainId: number | bigint | string;
  /** Path word W2 — the ephemeral/rotating index within an (account, chain). */
  readonly ephemeralIndex: number;
  /** Path word W0 — the account index. Defaults to the signer's account. */
  readonly railgunAccountIndex?: number;
};

export type RailgunRelayAdapt7702SignerRequest = {
  readonly railgunWalletID: string;
  readonly railgunAccountIndex: number;
  readonly chainId: bigint;
  readonly ephemeralIndex: number;
};

export type RailgunRelayAdapt7702SignerProvider = {
  readonly getPathSuffix: (index: number) => string;
  readonly getDBPathSuffix: () => string[];
  readonly getSigner: (
    request: RailgunRelayAdapt7702SignerRequest,
  ) => Promise<RailgunRelayAdapt7702HookedSigner>;
};

export type RailgunRelayAdapt7702SignerOptions = {
  readonly displayAddress?: boolean;
  readonly displayTypedDataHash?: boolean;
  readonly dbPathSuffix?: readonly string[];
  readonly onSessionPrepared?: (session: RailgunEthereumSignerSession) => void;
};

export type RailgunRelayAdapt7702SignerBackend = {
  prepareEthereumSigner(request: RailgunEthereumPreloadRequest): Promise<RailgunEthereumSignerSession>;
  signEip7702Authorization(request: Eip7702AuthorizationRequest): Promise<EthereumSignatureParts>;
  signEthereumTxHash(hash: Uint8Array, options?: EthereumTxHashSignOptions): Promise<EthereumSignatureParts>;
};

const EIP712_DOMAIN_TYPE_HASH = hashUtf8('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)');
const RELAY_ADAPT_EXECUTE_TYPE_HASH = hashUtf8('Execute(bytes32 payloadHash)');
const RELAY_ADAPT_NAME_HASH = hashUtf8('RelayAdapt7702');
const RELAY_ADAPT_VERSION_HASH = hashUtf8('1');

function hashUtf8(value: string): Uint8Array {
  return keccak_256(new TextEncoder().encode(value));
}

function concatBytes(...chunks: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function normalizeHex(value: string, bytes: number, label: string): string {
  const normalized = value.trim().replace(/^0x/i, '').toLowerCase();
  if (normalized.length !== bytes * 2 || /[^0-9a-f]/i.test(normalized)) {
    throw new Error(`${label} must be exactly ${String(bytes)} bytes of hex.`);
  }
  return `0x${normalized}`;
}

function normalizeBigInt(value: number | bigint | string, label: string): bigint {
  const normalized = BigInt(value);
  if (normalized < 0n) {
    throw new Error(`${label} must be non-negative.`);
  }
  return normalized;
}

function hexToBytes32(value: string, label: string): Uint8Array {
  return hexToBytes(normalizeHex(value, 32, label).slice(2));
}

function addressBytes32(address: string): Uint8Array {
  const bytes = hexToBytes(normalizeHex(address, 20, 'Address').slice(2));
  const output = new Uint8Array(32);
  output.set(bytes, 12);
  return output;
}

function uint256Bytes(value: bigint): Uint8Array {
  if (value < 0n || value > 0xffff_ffff_ffff_ffff_ffff_ffff_ffff_ffff_ffff_ffff_ffff_ffff_ffff_ffff_ffff_ffffn) {
    throw new Error('uint256 value is out of range.');
  }
  const bytes = new Uint8Array(32);
  let remaining = value;
  for (let index = 31; index >= 0; index -= 1) {
    bytes[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return bytes;
}

function sameAddress(left: string, right: string): boolean {
  return normalizeHex(left, 20, 'Address').toLowerCase() === normalizeHex(right, 20, 'Address').toLowerCase();
}

export function encodeEthereumSignature(signature: EthereumSignatureParts, legacyV = true): string {
  if (signature.yParity !== 0 && signature.yParity !== 1) {
    throw new Error(`Invalid signature yParity: ${String(signature.yParity)}.`);
  }
  const r = normalizeHex(signature.r, 32, 'Signature r').slice(2);
  const s = normalizeHex(signature.s, 32, 'Signature s').slice(2);
  const v = legacyV ? signature.yParity + 27 : signature.yParity;
  return `0x${r}${s}${v.toString(16).padStart(2, '0')}`;
}

export function buildRelayAdapt7702DomainSeparator(chainId: bigint, verifyingContract: string): string {
  return `0x${bytesToHex(keccak_256(concatBytes(
    EIP712_DOMAIN_TYPE_HASH,
    RELAY_ADAPT_NAME_HASH,
    RELAY_ADAPT_VERSION_HASH,
    uint256Bytes(chainId),
    addressBytes32(verifyingContract),
  )))}`;
}

export function buildRelayAdapt7702StructHash(payloadHash: string): string {
  return `0x${bytesToHex(keccak_256(concatBytes(
    RELAY_ADAPT_EXECUTE_TYPE_HASH,
    hexToBytes32(payloadHash, 'Payload hash'),
  )))}`;
}

export function buildRelayAdapt7702Digest(
  chainId: bigint,
  verifyingContract: string,
  payloadHash: string,
): string {
  const domainSeparator = buildRelayAdapt7702DomainSeparator(chainId, verifyingContract);
  const structHash = buildRelayAdapt7702StructHash(payloadHash);
  return `0x${bytesToHex(keccak_256(concatBytes(
    new Uint8Array([0x19, 0x01]),
    hexToBytes32(domainSeparator, 'Domain separator'),
    hexToBytes32(structHash, 'Hash struct message'),
  )))}`;
}

function assertRelayAdaptTypedData(
  domain: RelayAdapt7702TypedDataDomain,
  types: RelayAdapt7702TypedDataTypes,
  value: RelayAdapt7702TypedDataValue,
  session: RailgunEthereumSignerSession,
): string {
  if (domain.name !== 'RelayAdapt7702') {
    throw new Error('Unsupported EIP-712 domain name for RAILGUN 7702 signer.');
  }
  if (domain.version !== '1') {
    throw new Error('Unsupported EIP-712 domain version for RAILGUN 7702 signer.');
  }
  if (domain.chainId === undefined || normalizeBigInt(domain.chainId, 'EIP-712 domain chainId') !== session.chainId) {
    throw new Error('EIP-712 domain chainId does not match the prepared RAILGUN 7702 signer session.');
  }
  if (domain.verifyingContract === undefined || !sameAddress(domain.verifyingContract, session.address)) {
    throw new Error('EIP-712 verifyingContract does not match the prepared RAILGUN 7702 signer address.');
  }
  const executeFields = types.Execute;
  if (executeFields === undefined || executeFields.length !== 1) {
    throw new Error('Unsupported EIP-712 types for RAILGUN 7702 signer.');
  }
  const [payloadHashField] = executeFields;
  if (payloadHashField?.name !== 'payloadHash' || payloadHashField.type !== 'bytes32') {
    throw new Error('Unsupported EIP-712 Execute type for RAILGUN 7702 signer.');
  }
  const payloadHash = value.payloadHash;
  if (typeof payloadHash !== 'string') {
    throw new Error('RelayAdapt7702 Execute payloadHash must be a bytes32 hex string.');
  }
  return normalizeHex(payloadHash, 32, 'Payload hash');
}

export async function createRailgunRelayAdapt7702HookedSigner(
  controller: LedgerController,
  request: RailgunRelayAdapt7702SignerRequest,
  options: RailgunRelayAdapt7702SignerOptions = {},
): Promise<RailgunRelayAdapt7702HookedSigner> {
  const backend: RailgunRelayAdapt7702SignerBackend = {
    prepareEthereumSigner: (preloadRequest) => controller.prepareRailgunEthereumSigner(preloadRequest),
    signEip7702Authorization: (authorizationRequest) => {
      if (authorizationRequest.session === undefined) {
        throw new Error('Prepared RAILGUN 7702 signer session is required for controller authorization signing.');
      }
      return controller.signRailgunEip7702Authorization({
        session: authorizationRequest.session,
        contractAddressHex: `0x${bytesToHex(authorizationRequest.contractAddress)}`,
        nonce: authorizationRequest.nonce,
      });
    },
    signEthereumTxHash: (hash, hashOptions = {}) => {
      if (hashOptions.session === undefined) {
        throw new Error('Prepared RAILGUN 7702 signer session is required for controller hash signing.');
      }
      return controller.signRailgunEthereumHash(
        `0x${bytesToHex(hash)}`,
        hashOptions.session,
        hashOptions.display,
      );
    },
  };
  return createRailgunRelayAdapt7702HookedSignerFromRailgunSigner(backend, request, options);
}

export async function createRailgunRelayAdapt7702HookedSignerFromRailgunSigner(
  signer: RailgunRelayAdapt7702SignerBackend,
  request: RailgunRelayAdapt7702SignerRequest,
  options: RailgunRelayAdapt7702SignerOptions = {},
): Promise<RailgunRelayAdapt7702HookedSigner> {
  const preloadRequest: RailgunEthereumPreloadRequest = {
    railgunAccountIndex: request.railgunAccountIndex,
    chainId: request.chainId,
    ephemeralIndex: request.ephemeralIndex,
    displayAddress: options.displayAddress ?? false,
  };
  const session = await signer.prepareEthereumSigner(preloadRequest);
  options.onSessionPrepared?.(session);

  return {
    address: session.address,
    populateAuthorization: (
      authorizationRequest: RelayAdapt7702AuthorizationRequest,
    ): Promise<RelayAdapt7702AuthorizationRequest> => Promise.resolve(authorizationRequest),
    authorize: async (
      authorizationRequest: RelayAdapt7702AuthorizationRequest,
    ): Promise<RelayAdapt7702Authorization> => {
      const contractAddressHex = normalizeHex(authorizationRequest.address, 20, 'Authorization address');
      if (authorizationRequest.chainId !== undefined && normalizeBigInt(authorizationRequest.chainId, 'EIP-7702 authorization chainId') !== session.chainId) {
        throw new Error('EIP-7702 authorization chainId does not match the prepared RAILGUN 7702 signer session.');
      }
      if (authorizationRequest.nonce === undefined) {
        throw new Error('EIP-7702 authorization nonce is required for RAILGUN 7702 hardware signing.');
      }
      const nonce = normalizeBigInt(authorizationRequest.nonce, 'EIP-7702 authorization nonce');
      const signature = await signer.signEip7702Authorization({
        chainId: session.chainId,
        contractAddress: hexToBytes(contractAddressHex.slice(2)),
        session,
        nonce,
      });
      return {
        address: contractAddressHex,
        chainId: session.chainId,
        nonce,
        signature,
      };
    },
    signTypedData: async (
      domain: RelayAdapt7702TypedDataDomain,
      types: RelayAdapt7702TypedDataTypes,
      value: RelayAdapt7702TypedDataValue,
    ): Promise<string> => {
      const payloadHash = assertRelayAdaptTypedData(domain, types, value, session);
      const digest = buildRelayAdapt7702Digest(session.chainId, session.address, payloadHash);
      const signature = await signer.signEthereumTxHash(hexToBytes32(digest, 'Digest'), {
        session,
        display: options.displayTypedDataHash ?? true,
      });
      return encodeEthereumSignature(signature, true);
    },
  };
}

export function createRailgunRelayAdapt7702SignerProvider(
  controller: LedgerController,
  options: RailgunRelayAdapt7702SignerOptions = {},
): RailgunRelayAdapt7702SignerProvider {
  return {
    getPathSuffix: (index) => `${String(index)}'`,
    getDBPathSuffix: () => [...(options.dbPathSuffix ?? ['ledger'])],
    getSigner: (request) => createRailgunRelayAdapt7702HookedSigner(controller, request, options),
  };
}

export function createRailgun7702SignerProvider(
  controller: LedgerController,
  options: RailgunRelayAdapt7702SignerOptions = {},
): RailgunRelayAdapt7702SignerProvider {
  return createRailgunRelayAdapt7702SignerProvider(controller, options);
}
