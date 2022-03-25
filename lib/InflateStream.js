const Buffer = require('buffer').Buffer;
const zlib = require('zlib');

const INFLATE_TERMINATOR = Buffer.from([0, 0, 0xff, 0xff]);

module.exports = class InflateStream {
	constructor(callback) {
		this._inflate = new zlib.Inflate({
			chunkSize: 64 * 1024,
			flush: zlib.constants.Z_NO_FLUSH,
		});
		this._buffer = Buffer.allocUnsafe(32 * 1024);
		this._bufferLength = 0;
		this._blocker = Promise.resolve();
		this._push = 0;
		this._data = [];

		this._inflate.on('data', (chunk) => {
			this._data.push(chunk);

			if (this._push > 0) {
				// If inflate ever emits multiple chunks, we need to determine when we've received all of them. Unfortunately, Node.js does not make this easy.
				const lastChunk = this._data[this._data.length - 1];

				// Wait for more chunks if the last byte of the last chunk isn't the `}` character.
				if (lastChunk[lastChunk.length - 1] !== 125) return;

				let json = Buffer.concat(this._data).toString('utf8');

				try {
					json = JSON.parse(json);
				} catch (err) {
					// Parsing the JSON failed - wait for more chunks.
					return;
				}

				this._data = [];
				this._push--;

				callback(undefined, json);
			}
		});

		this._inflate.on('error', (err) => {
			// Force an error condition in push if ever reused after error
			this._inflate = null;
			this._push = -1;

			callback(err);
		});
	}

	_nextBlocker() {
		let resolve = null;
		const promise = this._blocker;

		const newPromise = new Promise((r) => resolve = r);
		this._blocker.then(newPromise);
		this._blocker = newPromise;

		return {promise, resolve};
	}

	async push(data) {
		const {promise, resolve} = this._nextBlocker();
		await promise;

		// Expand the message buffer if incoming message would overfill it.
		if (this._buffer.length - (this._bufferLength + data.length) < 0) {
			const old = this._buffer;
			this._buffer = Buffer.allocUnsafe(this._bufferLength + data.length);
			old.copy(this._buffer);
		}

		// Append incoming data to the buffer
		data.copy(this._buffer, this._bufferLength);
		this._bufferLength += data.length;

		// Check if we need to wait for more data.
		if (INFLATE_TERMINATOR.compare(this._buffer, this._bufferLength - 4, this._bufferLength) !== 0) {
			resolve();
			return false;
		}

		this._push++;

		try {
			this._inflate.write(this._buffer.slice(0, this._bufferLength), () => {
				resolve();
			});

			this._inflate.flush();
		} finally {
			this._bufferLength = 0;
		}
	}
};
