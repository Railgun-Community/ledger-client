/**
 * Tests for installer modules: APDU parser, ELF parser, crypto, SCP, priming, keys.
 *
 * Unit tests — no device required.
 */

import { describe, it, expect } from 'vitest';
import { parseCapdu, parseApduScript, countApduCommands, extractAppName, computeCodeHash, computeAppHash, computeCodeId } from '../../src/core/installer/apdu-parser.js';
import { tryGetTargetIdFromElf } from '../../src/core/installer/elf-parser.js';
import {
  ensurePrivateKey32,
  signSha256Der,
  verifySha256Der,
  getPublicKey,
  randomPrivateKey,
  randomBytes,
  deriveEcdhSecret,
  scpDeriveKeyV3,
  parseLv,
} from '../../src/core/installer/crypto.js';
import { ScpV2Session, ScpV3Session } from '../../src/core/installer/scp.js';
import { loadBundledInstallArtifact } from '../../src/core/installer/bundled-artifacts.js';
import {
  TRANSIENT_STATUS_WORDS,
  STATUS_HINTS,
  DEFAULT_TARGET_ID,
} from '../../src/core/installer/types.js';

// ─── APDU Parser ────────────────────────────────────────────────────────────

describe('APDU parser', () => {
  describe('parseCapdu', () => {
    it('should parse valid hex APDU', () => {
      const result = parseCapdu('e004000000');
      expect(result).toBeDefined();
      expect(result!.length).toBe(5);
      expect(result![0]).toBe(0xe0);
      expect(result![1]).toBe(0x04);
    });

    it('should reject odd-length hex', () => {
      expect(parseCapdu('e00400000')).toBeUndefined();
    });

    it('should reject non-hex characters', () => {
      expect(parseCapdu('e004zz0000')).toBeUndefined();
    });

    it('should reject too-short commands (< 5 bytes)', () => {
      expect(parseCapdu('e00400')).toBeUndefined();
    });

    it('should handle uppercase hex', () => {
      const result = parseCapdu('E004000000');
      expect(result).toBeDefined();
      expect(result![0]).toBe(0xe0);
    });
  });

  describe('parseApduScript', () => {
    it('should parse multi-line APDU script', () => {
      const script = `# Comment line
e004000000
e050000008aabbccdd11223344

# Another comment
B001000000
`;
      const commands = [...parseApduScript(script)];
      expect(commands.length).toBe(3);
      expect(commands[0]!.lineNumber).toBe(2);
      expect(commands[0]!.hex).toBe('e004000000');
      expect(commands[1]!.lineNumber).toBe(3);
      expect(commands[2]!.lineNumber).toBe(6);
    });

    it('should skip blank lines', () => {
      const commands = [...parseApduScript('\n\ne004000000\n\n')];
      expect(commands.length).toBe(1);
    });

    it('should handle 0x prefixed lines', () => {
      const commands = [...parseApduScript('0xe004000000')];
      expect(commands.length).toBe(1);
      expect(commands[0]!.bytes[0]).toBe(0xe0);
    });

    it('should handle whitespace in hex lines', () => {
      const commands = [...parseApduScript('e0 04 00 00 00')];
      expect(commands.length).toBe(1);
    });

    it('should return empty for empty input', () => {
      expect([...parseApduScript('')].length).toBe(0);
    });
  });

  describe('countApduCommands', () => {
    it('should count valid APDU lines', () => {
      const script = '# header\ne004000000\ne050000008aabbccdd11223344\n# footer\n';
      expect(countApduCommands(script)).toBe(2);
    });
  });

  describe('extractAppName', () => {
    it('should extract RAILGUN from real APDU format', () => {
      // First APDU: E0 00 00 00 09 0C 07 RAILGUN (5241494c47554e)
      const script = 'e0000000090c075241494c47554e\ne004000000\n';
      expect(extractAppName(script)).toBe('RAILGUN');
    });

    it('should return undefined for empty script', () => {
      expect(extractAppName('')).toBeUndefined();
    });

    it('should return undefined for short APDU', () => {
      expect(extractAppName('e004000000')).toBeUndefined();
    });

    it('should return undefined if name length overflows', () => {
      // nameLen = 0xFF but only a few bytes follow
      expect(extractAppName('e00000000a0cff46524f53')).toBeUndefined();
    });
  });

  describe('computeCodeHash', () => {
    it('should return SHA-256 of LOAD segment data', () => {
      // Build a single LOAD APDU: E0 00 00 00 <len> 06 <offset-hi> <offset-lo> <data>
      // Sub-cmd 0x06 at byte[5], offset bytes at [6..7], code data from [8..]
      const codeData = 'deadbeef';
      // payload = 06 00 00 + codeData = 7 bytes
      const payload = '060000' + codeData;
      const payloadLen = (payload.length / 2).toString(16).padStart(2, '0');
      const apdu = `e0000000${payloadLen}${payload}`;
      const hash = computeCodeHash(apdu);
      expect(hash).toBeDefined();
      expect(hash).toHaveLength(64); // SHA-256 hex = 64 chars
    });

    it('should concatenate multiple LOAD segments', () => {
      const apdu1 = 'e00000000706000011223344';
      const apdu2 = 'e00000000706000055667788';
      const hash = computeCodeHash(`${apdu1}\n${apdu2}`);
      expect(hash).toBeDefined();
      expect(hash).toHaveLength(64);
    });

    it('should return undefined when no LOAD segments exist', () => {
      // Sub-cmd 0x0c (CREATE), not 0x06
      expect(computeCodeHash('e00000000a0c0846524f535447554e')).toBeUndefined();
    });

    it('should return undefined for empty script', () => {
      expect(computeCodeHash('')).toBeUndefined();
    });

    it('should produce consistent hash for the real APDU file', async () => {
      const { readFileSync } = await import('node:fs');
      const { resolve } = await import('node:path');
      const apduData = readFileSync(resolve(__dirname, '../../apps/nanosp/app.apdu'), 'utf-8');
      const hash = computeCodeHash(apduData);
      expect(hash).toBeDefined();
      // Snapshot: SHA-256 of code segments from the real APDU file
      expect(hash).toBe('80cc62ba0a4ff0454509ddbbd6a47870cb3699fdc80ac1240f9324bb1208a4ec');
    });
  });

  describe('computeAppHash', () => {
    const NANO_SP_TARGET_ID = 0x33100004;

    it('should include targetId and PARAMS in the hash', () => {
      // PARAMS (0x0b) payload: api_level(1) + code_length(4) + data_length(4) + install_params_length(4) + flags(4) + boot_offset(4) = 21 bytes
      const paramsPayload = '0b' + '00'.repeat(21);
      const paramsApdu = `e000000016${paramsPayload}`;
      // LOAD (0x06) segment
      const loadApdu = 'e00000000706000011223344';
      const script = `${paramsApdu}\n${loadApdu}`;

      const appHash = computeAppHash(script, NANO_SP_TARGET_ID);
      const codeHash = computeCodeHash(script);
      expect(appHash).toBeDefined();
      expect(codeHash).toBeDefined();
      // App hash includes targetId + params, so must differ from code-only hash
      expect(appHash).not.toBe(codeHash);
    });

    it('should return undefined when no LOAD segments exist', () => {
      const paramsApdu = 'e000000016' + '0b' + '00'.repeat(21);
      expect(computeAppHash(paramsApdu, NANO_SP_TARGET_ID)).toBeUndefined();
    });

    it('should return undefined for empty script', () => {
      expect(computeAppHash('', NANO_SP_TARGET_ID)).toBeUndefined();
    });

    it('should produce the correct BOLOS app hash for the real APDU file', async () => {
      const { readFileSync } = await import('node:fs');
      const { resolve } = await import('node:path');
      const apduData = readFileSync(resolve(__dirname, '../../apps/nanosp/app.apdu'), 'utf-8');
      const hash = computeAppHash(apduData, NANO_SP_TARGET_ID);
      expect(hash).toBeDefined();
      // Snapshot: BOLOS "Application full hash" = SHA-256(targetId_BE32 + createAppParams + code_data)
      expect(hash).toBe('25ca9f78e8ccbdbbe9d2d1b7a2c51ba677717682d7254b31585cf4efcc6750f5');
    });

    it('should differ when targetId changes', async () => {
      const { readFileSync } = await import('node:fs');
      const { resolve } = await import('node:path');
      const apduData = readFileSync(resolve(__dirname, '../../apps/nanosp/app.apdu'), 'utf-8');
      const hashNanoSP = computeAppHash(apduData, NANO_SP_TARGET_ID);
      const hashStax = computeAppHash(apduData, 0x33200004);
      expect(hashNanoSP).toBeDefined();
      expect(hashStax).toBeDefined();
      expect(hashNanoSP).not.toBe(hashStax);
    });
  });

  describe('computeCodeId', () => {
    it('should hash code+data region excluding install_params', () => {
      // PARAMS: api_level=0, code_length=4, data_length=2, install_params_length=2, flags=0, boot=1
      // Total loaded = 4 + 2 + 2 = 8 bytes, code+data region = 4 + 2 = 6 bytes
      const paramsPayload = '0b' +
        '00' +                   // api_level
        '00000004' +             // code_length = 4
        '00000002' +             // data_length = 2
        '00000002' +             // install_params_length = 2
        '00000000' +             // flags
        '00000001';              // bootOffset
      const paramsApdu = `e000000016${paramsPayload}`;
      // LOAD with 8 bytes of data: AA BB CC DD (code) + EE FF (data) + 11 22 (install_params)
      const loadApdu = 'e00000000b060000aabbccddeeff1122';
      const script = `${paramsApdu}\n${loadApdu}`;

      const codeId = computeCodeId(script);
      const codeHash = computeCodeHash(script);
      expect(codeId).toBeDefined();
      expect(codeHash).toBeDefined();
      // CodeId should differ from codeHash (excludes install_params)
      expect(codeId).not.toBe(codeHash);
    });

    it('should return undefined when no LOAD segments exist', () => {
      const paramsApdu = 'e000000016' + '0b' + '00'.repeat(21);
      expect(computeCodeId(paramsApdu)).toBeUndefined();
    });

    it('should return undefined for empty script', () => {
      expect(computeCodeId('')).toBeUndefined();
    });

    it('should produce the correct BOLOS Code ID for the real APDU file', async () => {
      const { readFileSync } = await import('node:fs');
      const { resolve } = await import('node:path');
      const apduData = readFileSync(resolve(__dirname, '../../apps/nanosp/app.apdu'), 'utf-8');
      const codeId = computeCodeId(apduData);
      expect(codeId).toBeDefined();
      // Snapshot: BOLOS Code ID = SHA-256(code + data), excluding install_params.
      expect(codeId).toBe('e559bc60f84314cb12911966b8f7fef7d6893935e210b222b2223e05d892f641');
    });

    it('should differ from computeCodeHash for the real APDU file', async () => {
      const { readFileSync } = await import('node:fs');
      const { resolve } = await import('node:path');
      const apduData = readFileSync(resolve(__dirname, '../../apps/nanosp/app.apdu'), 'utf-8');
      const codeId = computeCodeId(apduData);
      const codeHash = computeCodeHash(apduData);
      expect(codeId).toBeDefined();
      expect(codeHash).toBeDefined();
      // codeId excludes the 64-byte install_params at the end
      expect(codeId).not.toBe(codeHash);
    });
  });
});

describe('Bundled install artifacts', () => {
  it('keeps top-level and versioned install bundles in sync', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');

    for (const target of ['nanosp', 'flex'] as const) {
      const topLevelApdu = readFileSync(resolve(__dirname, `../../apps/${target}/app.apdu`));
      const versionedApdu = readFileSync(resolve(__dirname, `../../apps/${target}/1.6.1/app.apdu`));
      const topLevelElf = readFileSync(resolve(__dirname, `../../apps/${target}/app.elf`));
      const versionedElf = readFileSync(resolve(__dirname, `../../apps/${target}/1.6.1/app.elf`));

      expect(versionedApdu.equals(topLevelApdu)).toBe(true);
      expect(versionedElf.equals(topLevelElf)).toBe(true);
    }
  });

  it('embeds the same install bundles used by the mock app', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');

    for (const target of ['nanosp', 'flex'] as const) {
      const artifact = loadBundledInstallArtifact(target);
      const topLevelApdu = readFileSync(resolve(__dirname, `../../apps/${target}/app.apdu`), 'utf8');
      const topLevelElf = readFileSync(resolve(__dirname, `../../apps/${target}/app.elf`));

      expect(artifact.apduData).toBe(topLevelApdu);
      expect(Buffer.from(artifact.elfData).equals(topLevelElf)).toBe(true);
    }
  });
});

// ─── ELF Parser ──────────────────────────────────────────────────────────────

describe('ELF parser', () => {
  it('should extract target ID from ELF with target string', () => {
    // Build a fake ELF with an embedded target string
    const marker = 'ledger.target_id=0x33100004';
    const bytes = new Uint8Array(marker.length + 20);
    for (let i = 0; i < marker.length; i++) {
      bytes[i + 10] = marker.charCodeAt(i);
    }
    expect(tryGetTargetIdFromElf(bytes)).toBe(0x33100004);
  });

  it('should extract target ID from any hex string as fallback', () => {
    const marker = 'something 0x31100002 here';
    const bytes = new Uint8Array(marker.length + 10);
    for (let i = 0; i < marker.length; i++) {
      bytes[i + 5] = marker.charCodeAt(i);
    }
    expect(tryGetTargetIdFromElf(bytes)).toBe(0x31100002);
  });

  it('should return undefined for binary without target ID', () => {
    const bytes = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x00]);
    expect(tryGetTargetIdFromElf(bytes)).toBeUndefined();
  });

  it('should return undefined for empty data', () => {
    expect(tryGetTargetIdFromElf(new Uint8Array(0))).toBeUndefined();
  });
});

// ─── Crypto ──────────────────────────────────────────────────────────────────

describe('crypto utilities', () => {
  const testKey = ensurePrivateKey32(
    '330ea33543913e04f41977fa42c20b6471bc6dbca6030dbec62883d2a6b96491',
  );

  describe('ensurePrivateKey32', () => {
    it('should parse hex string', () => {
      const key = ensurePrivateKey32('0x' + '01'.repeat(32));
      expect(key.length).toBe(32);
      expect(key[0]).toBe(0x01);
    });

    it('should reject short hex (no silent zero-padding)', () => {
      expect(() => ensurePrivateKey32('01')).toThrow('32 bytes');
    });

    it('should accept Uint8Array', () => {
      const bytes = new Uint8Array(32).fill(0xab);
      expect(ensurePrivateKey32(bytes)).toBe(bytes);
    });

    it('should reject wrong-length Uint8Array', () => {
      expect(() => ensurePrivateKey32(new Uint8Array(16))).toThrow('32 bytes');
    });

    it('should reject invalid hex', () => {
      expect(() => ensurePrivateKey32('not-hex')).toThrow('Invalid');
    });

    it('should reject overlength hex', () => {
      expect(() => ensurePrivateKey32('ab'.repeat(33))).toThrow('32 bytes');
    });
  });

  describe('signSha256Der / verifySha256Der', () => {
    it('should sign and verify data', () => {
      const data = new Uint8Array([1, 2, 3, 4]);
      const sig = signSha256Der(testKey, data);
      const pub = getPublicKey(testKey);
      expect(verifySha256Der(pub, data, sig)).toBe(true);
    });

    it('should fail verification with wrong data', () => {
      const data = new Uint8Array([1, 2, 3, 4]);
      const wrong = new Uint8Array([5, 6, 7, 8]);
      const sig = signSha256Der(testKey, data);
      const pub = getPublicKey(testKey);
      expect(verifySha256Der(pub, wrong, sig)).toBe(false);
    });

    it('should fail verification with wrong key', () => {
      const data = new Uint8Array([1, 2, 3, 4]);
      const sig = signSha256Der(testKey, data);
      const otherKey = randomPrivateKey();
      const otherPub = getPublicKey(otherKey);
      expect(verifySha256Der(otherPub, data, sig)).toBe(false);
    });
  });

  describe('getPublicKey', () => {
    it('should return uncompressed public key (65 bytes)', () => {
      const pub = getPublicKey(testKey);
      expect(pub.length).toBe(65);
      expect(pub[0]).toBe(0x04); // uncompressed prefix
    });
  });

  describe('randomPrivateKey', () => {
    it('should return 32-byte key', () => {
      const key = randomPrivateKey();
      expect(key.length).toBe(32);
    });

    it('should return different keys each time', () => {
      const a = randomPrivateKey();
      const b = randomPrivateKey();
      expect(a).not.toEqual(b);
    });
  });

  describe('randomBytes', () => {
    it('should return requested length', () => {
      expect(randomBytes(8).length).toBe(8);
      expect(randomBytes(32).length).toBe(32);
    });

    it('should return different values', () => {
      const a = randomBytes(32);
      const b = randomBytes(32);
      expect(a).not.toEqual(b);
    });
  });

  describe('deriveEcdhSecret', () => {
    it('should produce 32-byte shared secret', () => {
      const keyA = randomPrivateKey();
      const keyB = randomPrivateKey();
      const pubB = getPublicKey(keyB);
      const secret = deriveEcdhSecret(keyA, pubB);
      expect(secret.length).toBe(32);
    });

    it('should produce same secret with reversed roles', () => {
      const keyA = randomPrivateKey();
      const keyB = randomPrivateKey();
      const pubA = getPublicKey(keyA);
      const pubB = getPublicKey(keyB);
      const secretAB = deriveEcdhSecret(keyA, pubB);
      const secretBA = deriveEcdhSecret(keyB, pubA);
      expect(secretAB).toEqual(secretBA);
    });
  });

  describe('scpDeriveKeyV3', () => {
    it('should return 32-byte derived key', () => {
      const secret = randomBytes(32);
      const key = scpDeriveKeyV3(secret, 0);
      expect(key.length).toBe(32);
    });

    it('should produce different keys for different indices', () => {
      const secret = randomBytes(32);
      const key0 = scpDeriveKeyV3(secret, 0);
      const key1 = scpDeriveKeyV3(secret, 1);
      expect(key0).not.toEqual(key1);
    });
  });

  describe('parseLv', () => {
    it('should parse length-value pair', () => {
      const buf = new Uint8Array([3, 0xaa, 0xbb, 0xcc, 0xff]);
      const result = parseLv(buf, 0);
      expect(result.value).toEqual(new Uint8Array([0xaa, 0xbb, 0xcc]));
      expect(result.nextOffset).toBe(4);
    });

    it('should parse from offset', () => {
      const buf = new Uint8Array([0x00, 0x00, 2, 0x11, 0x22]);
      const result = parseLv(buf, 2);
      expect(result.value).toEqual(new Uint8Array([0x11, 0x22]));
      expect(result.nextOffset).toBe(5);
    });

    it('should throw on out-of-range offset', () => {
      expect(() => parseLv(new Uint8Array([1, 2]), 5)).toThrow('missing length');
    });

    it('should throw on value exceeding buffer', () => {
      expect(() => parseLv(new Uint8Array([0x10, 0x01]), 0)).toThrow('out-of-range');
    });
  });
});

// ─── SCP Sessions ────────────────────────────────────────────────────────────

describe('SCP sessions', () => {
  describe('ScpV2Session', () => {
    it('should wrap and unwrap data symmetrically', () => {
      const key = randomBytes(16);
      const session1 = new ScpV2Session(key);
      const session2 = new ScpV2Session(key);

      const data = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05]);
      const wrapped = session1.wrap(data);

      // Wrapped should be block-aligned and different from input
      expect(wrapped.length % 16).toBe(0);
      expect(wrapped).not.toEqual(data);

      const unwrapped = session2.unwrap(wrapped);
      expect(unwrapped).toEqual(data);
    });

    it('should handle empty data', () => {
      const key = randomBytes(16);
      const session = new ScpV2Session(key);
      expect(session.wrap(new Uint8Array(0))).toEqual(new Uint8Array(0));
      expect(session.unwrap(new Uint8Array(0))).toEqual(new Uint8Array(0));
    });

    it('should maintain IV state across multiple wraps', () => {
      const key = randomBytes(16);
      const wrapSession = new ScpV2Session(key);
      const unwrapSession = new ScpV2Session(key);

      for (let i = 0; i < 5; i++) {
        const data = randomBytes(20);
        const wrapped = wrapSession.wrap(data);
        const unwrapped = unwrapSession.unwrap(wrapped);
        expect(unwrapped).toEqual(data);
      }
    });

    it('should reject non-16-byte key', () => {
      expect(() => new ScpV2Session(randomBytes(8))).toThrow('16 bytes');
    });

    it('should reject non-block-aligned unwrap input', () => {
      const key = randomBytes(16);
      const session = new ScpV2Session(key);
      expect(() => session.unwrap(randomBytes(13))).toThrow('payload length');
    });
  });

  describe('ScpV3Session', () => {
    it('should wrap and unwrap data symmetrically', () => {
      const encKey = randomBytes(16);
      const macKey = randomBytes(16);
      const session1 = new ScpV3Session(encKey, macKey);
      const session2 = new ScpV3Session(encKey, macKey);

      const data = new Uint8Array([0x10, 0x20, 0x30]);
      const wrapped = session1.wrap(data);

      // Wrapped includes encrypted data + 14-byte MAC suffix
      expect(wrapped.length).toBeGreaterThan(data.length);
      const encrypted = wrapped.subarray(0, wrapped.length - 0x0e);
      expect(encrypted.length % 16).toBe(0);

      const unwrapped = session2.unwrap(wrapped);
      expect(unwrapped).toEqual(data);
    });

    it('should handle empty data', () => {
      const session = new ScpV3Session(randomBytes(16), randomBytes(16));
      expect(session.wrap(new Uint8Array(0))).toEqual(new Uint8Array(0));
      expect(session.unwrap(new Uint8Array(0))).toEqual(new Uint8Array(0));
    });

    it('should detect MAC tampering', () => {
      const encKey = randomBytes(16);
      const macKey = randomBytes(16);
      const session1 = new ScpV3Session(encKey, macKey);
      const session2 = new ScpV3Session(encKey, macKey);

      const data = randomBytes(32);
      const wrapped = session1.wrap(data);

      // Tamper with MAC suffix
      const tampered = new Uint8Array(wrapped);
      tampered[tampered.length - 1] ^= 0xff;

      expect(() => session2.unwrap(tampered)).toThrow('Invalid SCP MAC');
    });

    it('should reject non-16-byte keys', () => {
      expect(() => new ScpV3Session(randomBytes(8), randomBytes(16))).toThrow('16 bytes');
      expect(() => new ScpV3Session(randomBytes(16), randomBytes(8))).toThrow('16 bytes');
    });

    it('should maintain state across multiple wraps', () => {
      const encKey = randomBytes(16);
      const macKey = randomBytes(16);
      const wrapSession = new ScpV3Session(encKey, macKey);
      const unwrapSession = new ScpV3Session(encKey, macKey);

      for (let i = 0; i < 5; i++) {
        const data = randomBytes(20);
        const wrapped = wrapSession.wrap(data);
        const unwrapped = unwrapSession.unwrap(wrapped);
        expect(unwrapped).toEqual(data);
      }
    });
  });
});

// ─── Types / Constants ──────────────────────────────────────────────────────

describe('installer constants', () => {
  it('should have expected default target ID', () => {
    expect(DEFAULT_TARGET_ID).toBe(0x33100004);
  });

  it('should have transient status words', () => {
    expect(TRANSIENT_STATUS_WORDS.has('5515')).toBe(true);
    expect(TRANSIENT_STATUS_WORDS.has('6615')).toBe(true);
    expect(TRANSIENT_STATUS_WORDS.has('6985')).toBe(true);
    expect(TRANSIENT_STATUS_WORDS.has('9000')).toBe(false);
  });

  it('should have status hints for known codes', () => {
    expect(STATUS_HINTS['6615']).toContain('busy');
    expect(STATUS_HINTS['5515']).toContain('locked');
    expect(STATUS_HINTS['6985']).toContain('Condition');
  });
});
