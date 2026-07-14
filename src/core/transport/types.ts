/**
 * Transport layer types.
 *
 * Abstracts the communication channel to a hardware wallet device.
 * Implementations: WebHID (browser), Node HID (CLI), BLE (future — inject via transportFactory).
 */

/** Raw APDU command to send to the device. */
export type ApduCommand = {
  /** Class byte */
  readonly cla: number;
  /** Instruction byte */
  readonly ins: number;
  /** Parameter 1 */
  readonly p1: number;
  /** Parameter 2 */
  readonly p2: number;
  /** Command data (optional) */
  readonly data?: Uint8Array;
};

/** Parsed APDU response from the device. */
export type ApduResponse = {
  /** Response data (excluding status word) */
  readonly data: Uint8Array;
  /** Status word (2 bytes, e.g., 0x9000) */
  readonly statusWord: number;
};

/** APDU status word constants. */
export const StatusWord = {
  SUCCESS: 0x9000,
  USER_REJECTED: 0x6985,
  WRONG_LENGTH: 0x6700,
  INVALID_DATA: 0x6a80,
  INVALID_P1P2: 0x6b00,
  INS_NOT_SUPPORTED: 0x6d00,
  CLA_NOT_SUPPORTED: 0x6e00,
  APP_NOT_OPEN: 0x6e01,
  INTERNAL_ERROR: 0x6f00,
  LOCKED_DEVICE: 0x5515,
  /** BOLOS: returned by OPEN_APP when the requested application is not installed. */
  APP_NOT_FOUND: 0x6807,
} as const;

export type StatusWord = (typeof StatusWord)[keyof typeof StatusWord];

/** Transport type discriminator. */
export type TransportType = 'webhid' | 'nodehid' | 'ble';

/** Abstract transport interface — all device communication goes through this. */
export interface HWTransport {
  readonly type: TransportType;

  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(command: ApduCommand): Promise<ApduResponse>;
  /**
   * Exchange raw APDU bytes with the device.
   * Returns full response including status word as trailing 2 bytes.
   * Required by SCP installer flow where pre-wrapped APDUs bypass structured parsing.
   */
  rawExchange(apdu: Uint8Array): Promise<Uint8Array>;
  isConnected(): boolean;
  onDisconnect(cb: () => void): () => void;
}

/** Configuration for transport creation. */
export type TransportConfig = {
  readonly type: TransportType;
  /** Timeout in ms for APDU operations. Default: 30000 */
  readonly timeout?: number;
};
