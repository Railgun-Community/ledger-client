/**
 * Transport factory.
 *
 * Creates the appropriate HWTransport implementation based on config.
 * Single entry point for transport creation — keeps the rest of the
 * codebase decoupled from specific transport implementations.
 */

import type { HWTransport, TransportConfig } from './types.js';
import { HWError, HWErrorCode } from '../errors.js';
import { WebHIDTransport } from './webhid-transport.js';

/**
 * Create an HWTransport instance based on configuration.
 *
 * @param config - Transport configuration. Defaults to WebHID.
 * @returns An unconnected HWTransport. Call connect() before use.
 */
export function createTransport(config?: TransportConfig): HWTransport {
  const type = config?.type ?? 'webhid';

  switch (type) {
    case 'webhid':
      return new WebHIDTransport(config);

    case 'ble':
      throw new HWError(
        HWErrorCode.TRANSPORT_NOT_AVAILABLE,
        'BLE transport is not yet implemented.',
      );

    default: {
      const _exhaustive: never = type;
      throw new HWError(
        HWErrorCode.TRANSPORT_NOT_AVAILABLE,
        `Unknown transport type: ${String(_exhaustive)}`,
      );
    }
  }
}
