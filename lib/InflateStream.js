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
		this._push = false;
		this._data = [];

		this._inflate.on('data', (chunk) => {
			this._data.push(chunk);

			if (this._push) {
				// In theory, if inflate ever emits multiple chunks, we need to determine when we've received all of them. Unfortunately, Node.js does not make this easy.
				const lastChunk = this._data[this._data.length - 1];

				// Wait for more chunks if the last byte of the last chunk is the `}` character.
				if (lastChunk[lastChunk.length - 1] !== 125) return;

				let json = Buffer.concat(this._data).toString('utf8');

				try {
					json = JSON.parse(json);
				} catch (err) {
					// Parsing the JSON failed - wait for more chunks.
					return;
				}

				this._data = [];
				this._push = false;

				callback(undefined, json);
			}
		});

		this._inflate.on('error', (err) => {
			if (this._push) {
				// Force an error condition in push if ever reused
				this._inflate = null;
				this._push = false;

				callback(err);
			}
		});
	}

	push(data) {
		// Expand the message buffer if incoming message would overfill it.
		if (this._buffer.length - (this._bufferLength + data.length) < 0) {
			const old = this._buffer;
			this._buffer = Buffer.allocUnsafe(this._bufferLength + data.length);
			old.copy(this._buffer);
		}

		data.copy(this._buffer, this._bufferLength);
		this._bufferLength += data.length;

		if (INFLATE_TERMINATOR.compare(this._buffer, this._bufferLength - 4, this._bufferLength) !== 0) {
			// We need to wait for more data.
			return false;
		}

		this._push = true;

		try {
			this._inflate.write(this._buffer.slice(0, this._bufferLength));

			this._inflate.flush();
		} finally {
			this._bufferLength = 0;
		}
	}
};
