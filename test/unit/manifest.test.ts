/**
 * Tests for manifest validation (T4 — binaryPath path-traversal guard).
 *
 * binaryPath crosses the User → UI file-upload trust boundary and is later
 * resolved to load the binary, so it must be a relative path that cannot
 * escape its base directory.
 */

import { describe, it, expect } from 'vitest';
import { validateManifest } from '../../src/validation/manifest.js';
import { HWErrorCode } from '../../src/core/errors.js';

function base(): Record<string, unknown> {
  return {
    name: 'RAILGUN',
    version: '1.0.0',
    targetId: 0x33000004,
    binaryPath: 'app.hex',
    dataSize: 1024,
  };
}

describe('validateManifest — valid input', () => {
  it('accepts a plain relative binaryPath', () => {
    expect(() => validateManifest(base())).not.toThrow();
  });

  it('accepts a nested relative binaryPath', () => {
    expect(() => validateManifest({ ...base(), binaryPath: 'bin/nanosp/app.hex' })).not.toThrow();
  });

  it('accepts a filename with dots that are not a traversal segment', () => {
    expect(() => validateManifest({ ...base(), binaryPath: 'app..v2.hex' })).not.toThrow();
    expect(() => validateManifest({ ...base(), binaryPath: './app.hex' })).not.toThrow();
  });
});

describe('validateManifest — binaryPath traversal guard', () => {
  const traversalCases: Array<[string, string]> = [
    ['parent segment', '../secret.hex'],
    ['nested parent segment', 'bin/../../etc/passwd'],
    ['trailing parent segment', 'bin/..'],
    ['backslash parent segment', 'bin\\..\\..\\secret'],
    ['POSIX absolute', '/etc/passwd'],
    ['UNC / backslash absolute', '\\\\server\\share\\x'],
    ['Windows drive (backslash)', 'C:\\Windows\\System32'],
    ['Windows drive (forward slash)', 'C:/Windows/System32'],
  ];

  for (const [label, binaryPath] of traversalCases) {
    it(`rejects ${label}: ${JSON.stringify(binaryPath)}`, () => {
      expect(() => validateManifest({ ...base(), binaryPath })).toThrowError(
        /relative path/,
      );
    });
  }

  it('rejects a NUL byte in binaryPath', () => {
    const withNul = `app${String.fromCharCode(0x00)}.hex`;
    expect(() => validateManifest({ ...base(), binaryPath: withNul })).toThrowError(
      /relative path/,
    );
  });

  it('rejects a control character (0x1f) in binaryPath', () => {
    const withCtrl = `app${String.fromCharCode(0x1f)}.hex`;
    expect(() => validateManifest({ ...base(), binaryPath: withCtrl })).toThrowError(
      /relative path/,
    );
  });

  it('surfaces the traversal rejection as a VALIDATION_MANIFEST error', () => {
    expect(() => validateManifest({ ...base(), binaryPath: '../x' })).toThrowError(
      expect.objectContaining({ code: HWErrorCode.VALIDATION_MANIFEST }),
    );
  });
});

describe('validateManifest — existing field checks still hold', () => {
  it('rejects an empty binaryPath', () => {
    expect(() => validateManifest({ ...base(), binaryPath: '' })).toThrowError(
      /non-empty string/,
    );
  });

  it('rejects a non-string binaryPath', () => {
    expect(() => validateManifest({ ...base(), binaryPath: 123 })).toThrowError(
      /non-empty string/,
    );
  });

  it('rejects a missing required field', () => {
    const m = base();
    delete m['name'];
    expect(() => validateManifest(m)).toThrowError(/name/);
  });
});
