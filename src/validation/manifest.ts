/**
 * Manifest validation.
 *
 * Trust boundary #3: User → UI (file uploads).
 * Validates uploaded app manifests and binary files.
 */

import type { AppManifest } from '../core/installer/types.js';
import { MAX_BINARY_SIZE, MAX_MANIFEST_SIZE } from '../core/installer/types.js';
import { HWError, HWErrorCode } from '../core/errors.js';

/**
 * Reject a manifest-supplied path that could escape its base directory.
 *
 * binaryPath is attacker-controlled (uploaded manifest) and is later resolved
 * to load the binary, so it must be a relative path with no absolute prefix
 * (POSIX `/`, UNC/`\`, or Windows drive), no `..` segments, and no NUL/control
 * characters.
 */
function isUnsafeBinaryPath(path: string): boolean {
  if (path.startsWith('/') || path.startsWith('\\') || /^[a-zA-Z]:/.test(path)) {
    return true;
  }
  for (const ch of path) {
    const code = ch.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return true; // control chars incl. NUL
  }
  return path.split(/[/\\]/).some((segment) => segment === '..');
}

/**
 * Validate an app manifest object.
 * Ensures all required fields are present and well-formed.
 */
export function validateManifest(manifest: unknown): asserts manifest is AppManifest {
  if (manifest === null || manifest === undefined || typeof manifest !== 'object') {
    throw new HWError(
      HWErrorCode.VALIDATION_MANIFEST,
      'Manifest must be a non-null object',
    );
  }

  const obj = manifest as Record<string, unknown>;

  if (typeof obj['name'] !== 'string' || obj['name'].length === 0) {
    throw new HWError(
      HWErrorCode.VALIDATION_MANIFEST,
      'Manifest name must be a non-empty string',
    );
  }

  if (typeof obj['version'] !== 'string' || obj['version'].length === 0) {
    throw new HWError(
      HWErrorCode.VALIDATION_MANIFEST,
      'Manifest version must be a non-empty string',
    );
  }

  if (typeof obj['targetId'] !== 'number' || !Number.isInteger(obj['targetId'])) {
    throw new HWError(
      HWErrorCode.VALIDATION_MANIFEST,
      'Manifest targetId must be an integer',
    );
  }

  const binaryPath = obj['binaryPath'];
  if (typeof binaryPath !== 'string' || binaryPath.length === 0) {
    throw new HWError(
      HWErrorCode.VALIDATION_MANIFEST,
      'Manifest binaryPath must be a non-empty string',
    );
  }
  if (isUnsafeBinaryPath(binaryPath)) {
    throw new HWError(
      HWErrorCode.VALIDATION_MANIFEST,
      'Manifest binaryPath must be a relative path without ".." segments',
    );
  }

  if (typeof obj['dataSize'] !== 'number' || !Number.isInteger(obj['dataSize']) || obj['dataSize'] < 0) {
    throw new HWError(
      HWErrorCode.VALIDATION_MANIFEST,
      'Manifest dataSize must be a non-negative integer',
    );
  }

  if (obj['icon'] !== undefined && typeof obj['icon'] !== 'string') {
    throw new HWError(
      HWErrorCode.VALIDATION_MANIFEST,
      'Manifest icon must be a string if present',
    );
  }
}

/**
 * Validate uploaded binary file size.
 */
export function validateBinarySize(size: number): void {
  if (size <= 0) {
    throw new HWError(
      HWErrorCode.VALIDATION_MANIFEST,
      'Binary file is empty',
    );
  }
  if (size > MAX_BINARY_SIZE) {
    throw new HWError(
      HWErrorCode.VALIDATION_MANIFEST,
      `Binary file exceeds maximum size of ${String(MAX_BINARY_SIZE)} bytes`,
    );
  }
}

/**
 * Validate uploaded manifest file size.
 */
export function validateManifestFileSize(size: number): void {
  if (size <= 0) {
    throw new HWError(
      HWErrorCode.VALIDATION_MANIFEST,
      'Manifest file is empty',
    );
  }
  if (size > MAX_MANIFEST_SIZE) {
    throw new HWError(
      HWErrorCode.VALIDATION_MANIFEST,
      `Manifest file exceeds maximum size of ${String(MAX_MANIFEST_SIZE)} bytes`,
    );
  }
}
