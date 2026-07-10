export type SpendingPublicKey = {
  readonly x: bigint;
  readonly y: bigint;
};

export type RailgunWalletArtifacts = {
  readonly spendingPublicKey: SpendingPublicKey;
  readonly shareableViewingKey: string;
  readonly railgunAddress: string;
};

type CircomBabyJubModule = {
  babyjub: {
    packPoint(point: readonly [bigint, bigint]): Uint8Array | ArrayLike<number>;
  };
};

const BECH32M_CONST = 0x2bc830a3;
const BECH32M_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const RAILGUN_ALL_CHAINS_NETWORK_ID = new Uint8Array([0x8d, 0x9e, 0x96, 0x93, 0x98, 0x8a, 0x91, 0xff]);

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }
  return combined;
}

function encodeMsgpackString(value: string): Uint8Array {
  const bytes = new TextEncoder().encode(value);
  if (bytes.length <= 31) {
    return concatBytes([Uint8Array.of(0xa0 + bytes.length), bytes]);
  }
  if (bytes.length <= 0xff) {
    return concatBytes([Uint8Array.of(0xd9, bytes.length), bytes]);
  }
  return concatBytes([
    Uint8Array.of(0xda, (bytes.length >> 8) & 0xff, bytes.length & 0xff),
    bytes,
  ]);
}

function encodeEngineShareableViewingKeyPayload(
  viewingPrivateKeyHex: string,
  spendingPublicKeyHex: string,
): string {
  const encoded = concatBytes([
    Uint8Array.of(0x82),
    encodeMsgpackString('vpriv'),
    encodeMsgpackString(viewingPrivateKeyHex),
    encodeMsgpackString('spub'),
    encodeMsgpackString(spendingPublicKeyHex),
  ]);
  return bytesToHex(encoded);
}

async function packEngineSpendingPublicKey(spendingPublicKey: SpendingPublicKey): Promise<string> {
  // circomlibjs lands its exports on `.default` under ESM/bundlers (browser) but
  // directly on the namespace under CJS — mirror the poseidon access below.
  const circom = await import('@railgun-community/circomlibjs') as unknown as
    CircomBabyJubModule & { default?: CircomBabyJubModule };
  const babyjub = circom.default?.babyjub ?? circom.babyjub;
  const packed = babyjub.packPoint([spendingPublicKey.x, spendingPublicKey.y]);
  return bytesToHex(Uint8Array.from(packed));
}

function bech32mPolymod(values: readonly number[]): number {
  const generators = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const value of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ value;
    for (let bit = 0; bit < 5; bit++) {
      if ((top >> bit) & 1) {
        chk ^= generators[bit]!;
      }
    }
  }
  return chk;
}

function bech32mHrpExpand(hrp: string): number[] {
  const expanded: number[] = [];
  for (let index = 0; index < hrp.length; index++) {
    expanded.push(hrp.charCodeAt(index) >> 5);
  }
  expanded.push(0);
  for (let index = 0; index < hrp.length; index++) {
    expanded.push(hrp.charCodeAt(index) & 31);
  }
  return expanded;
}

function bech32mCreateChecksum(hrp: string, words: readonly number[]): number[] {
  const values = [...bech32mHrpExpand(hrp), ...words, 0, 0, 0, 0, 0, 0];
  const polymod = bech32mPolymod(values) ^ BECH32M_CONST;
  const checksum: number[] = [];
  for (let index = 0; index < 6; index++) {
    checksum.push((polymod >> (5 * (5 - index))) & 31);
  }
  return checksum;
}

function bech32mToWords(data: Uint8Array): number[] {
  let value = 0;
  let bits = 0;
  const words: number[] = [];
  for (let index = 0; index < data.length; index++) {
    value = (value << 8) | data[index]!;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      words.push((value >> bits) & 31);
    }
  }
  if (bits > 0) {
    words.push((value << (5 - bits)) & 31);
  }
  return words;
}

function bech32mEncode(hrp: string, words: readonly number[], limit: number): string {
  const checksum = bech32mCreateChecksum(hrp, words);
  let encoded = `${hrp}1`;
  for (const word of [...words, ...checksum]) {
    encoded += BECH32M_CHARSET[word]!;
  }
  if (encoded.length > limit) {
    throw new Error('bech32m exceeds limit');
  }
  return encoded;
}

function bigintTo32Bytes(value: bigint): Uint8Array {
  const hex = value.toString(16).padStart(64, '0');
  const bytes = new Uint8Array(32);
  for (let index = 0; index < 32; index++) {
    bytes[index] = Number.parseInt(hex.substring(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

// Host-side 0zk address derivation. There is no firmware APDU that returns the
// 0zk address or the master public key — the RAILGUN app exposes only the spending
// public key and the (exportable) viewing private key, and the address is derived
// from those host-side. This mirrors the firmware reference's own host derivation
// (RAILGUN-HW/js/test-apdus.js §3). Required by deriveRailgunWalletArtifacts.
async function derive0zkAddress(
  spendingPublicKey: SpendingPublicKey,
  viewingPrivateKey: Uint8Array,
): Promise<string> {
  const circom = await import('@railgun-community/circomlibjs');
  const poseidon = circom.default.poseidon ?? circom.poseidon;
  const viewingPrivateKeyBigint = BigInt(`0x${bytesToHex(viewingPrivateKey)}`);
  const nullifyingKey = poseidon([viewingPrivateKeyBigint]);
  const masterPublicKey = poseidon([
    spendingPublicKey.x,
    spendingPublicKey.y,
    nullifyingKey,
  ]);
  const { ed25519 } = await import('@noble/curves/ed25519.js');
  const viewingPublicKey = ed25519.getPublicKey(viewingPrivateKey);
  const payload = concatBytes([
    Uint8Array.of(0x01),
    bigintTo32Bytes(masterPublicKey),
    RAILGUN_ALL_CHAINS_NETWORK_ID,
    viewingPublicKey,
  ]);
  return bech32mEncode('0zk', bech32mToWords(payload), 127);
}

export async function deriveRailgunWalletArtifacts(
  spendingPublicKey: SpendingPublicKey,
  viewingPrivateKey: Uint8Array,
): Promise<RailgunWalletArtifacts> {
  const [spendingPublicKeyHex, railgunAddress] = await Promise.all([
    packEngineSpendingPublicKey(spendingPublicKey),
    derive0zkAddress(spendingPublicKey, viewingPrivateKey),
  ]);

  return {
    spendingPublicKey,
    shareableViewingKey: encodeEngineShareableViewingKeyPayload(
      bytesToHex(viewingPrivateKey),
      spendingPublicKeyHex,
    ),
    railgunAddress,
  };
}
