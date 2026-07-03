/**
 * WebHID transport adapter.
 *
 * Wraps @ledgerhq/hw-transport-webhid behind the HWTransport interface.
 * Handles connection lifecycle, APDU send/receive, timeout, and disconnect events.
 *
 * Invariants:
 * - connect() requires user gesture (WebHID permission prompt)
 * - send() rejects if not connected
 * - Timeout enforced on every APDU exchange
 * - Disconnect listeners fire on both explicit disconnect and USB unplug
 */

import type { HWTransport, ApduCommand, ApduResponse, TransportConfig } from './types.js';
import { HWError, HWErrorCode } from '../errors.js';
import { deserializeApduResponse } from './apdu-wire.js';
import TransportWebHID from '@ledgerhq/hw-transport-webhid';
import { TransportStatusError } from '@ledgerhq/errors';

/** Default APDU timeout in ms. */
const DEFAULT_TIMEOUT = 30_000;

export class WebHIDTransport implements HWTransport {
	readonly type = 'webhid' as const;

	private _transport: import('@ledgerhq/hw-transport').default | null = null;
	private _disconnectCallbacks: Array<() => void> = [];
	private _timeout: number;

	constructor(config?: TransportConfig) {
		this._timeout = config?.timeout ?? DEFAULT_TIMEOUT;
	}

	async connect(): Promise<void> {
		if (this._transport !== null) {
			throw new HWError(
				HWErrorCode.TRANSPORT_CONNECTION_FAILED,
				'Transport already connected. Disconnect first.',
			);
		}

		if (typeof globalThis.navigator === 'undefined' || !('hid' in globalThis.navigator)) {
			throw new HWError(
				HWErrorCode.TRANSPORT_NOT_AVAILABLE,
				'WebHID is not available. Requires HTTPS or localhost in a supported browser.',
			);
		}

		try {
			this._transport = await TransportWebHID.create();
		} catch (err: unknown) {
			throw new HWError(
				HWErrorCode.TRANSPORT_CONNECTION_FAILED,
				'Failed to connect via WebHID. User may have cancelled the permission dialog.',
				err,
			);
		}

		this._transport.on('disconnect', () => {
			this._handleDisconnect();
		});
	}

	async disconnect(): Promise<void> {
		if (this._transport === null) {
			return;
		}

		try {
			await this._transport.close();
		} finally {
			this._transport = null;
		}
	}

	async send(command: ApduCommand): Promise<ApduResponse> {
		if (this._transport === null) {
			throw new HWError(
				HWErrorCode.TRANSPORT_DISCONNECTED,
				'Cannot send APDU: transport not connected.',
			);
		}

		const statusList = [0x9000];

		try {
			const result = await this._withTimeout(
				this._transport.send(
					command.cla,
					command.ins,
					command.p1,
					command.p2,
					command.data !== undefined && command.data.length > 0
						? Uint8Array.from(command.data) as never
						: undefined,
					statusList,
				).catch((err: unknown) => {
					if (err instanceof TransportStatusError) {
						const sw = err.statusCode;
						return Uint8Array.from([(sw >> 8) & 0xff, sw & 0xff]);
					}
					throw err;
				}),
			);

			const raw = new Uint8Array(result);
			return deserializeApduResponse(raw);
		} catch (err: unknown) {
			if (err instanceof HWError) {
				throw err;
			}
			throw new HWError(
				HWErrorCode.TRANSPORT_DISCONNECTED,
				'APDU exchange failed - device may have disconnected.',
				err,
			);
		}
	}

	isConnected(): boolean {
		return this._transport !== null;
	}

	async rawExchange(apdu: Uint8Array): Promise<Uint8Array> {
		if (this._transport === null) {
			throw new HWError(
				HWErrorCode.TRANSPORT_DISCONNECTED,
				'Cannot exchange: transport not connected.',
			);
		}

		try {
			const result = await this._withTimeout(
				this._transport.exchange(Uint8Array.from(apdu) as never),
			);
			return new Uint8Array(result);
		} catch (err: unknown) {
			if (err instanceof HWError) {
				throw err;
			}
			throw new HWError(
				HWErrorCode.TRANSPORT_DISCONNECTED,
				'Raw APDU exchange failed - device may have disconnected.',
				err,
			);
		}
	}

	onDisconnect(cb: () => void): () => void {
		this._disconnectCallbacks.push(cb);
		return (): void => {
			this._disconnectCallbacks = this._disconnectCallbacks.filter((c) => c !== cb);
		};
	}

	private _handleDisconnect(): void {
		this._transport = null;
		const callbacks = [...this._disconnectCallbacks];
		for (const cb of callbacks) {
			cb();
		}
	}

	private async _withTimeout<T>(promise: Promise<T>): Promise<T> {
		let timer: ReturnType<typeof setTimeout> | undefined;

		const timeout = new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => {
				reject(
					new HWError(
						HWErrorCode.TRANSPORT_TIMEOUT,
						`APDU timed out after ${String(this._timeout)}ms`,
					),
				);
			}, this._timeout);
		});

		try {
			return await Promise.race([promise, timeout]);
		} finally {
			if (timer !== undefined) {
				clearTimeout(timer);
			}
		}
	}
}
