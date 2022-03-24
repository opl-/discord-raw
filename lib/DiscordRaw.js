'use strict';

const WebSocket = require('ws');
const https = require('https');
const url = require('url');
const EventEmitter = require('events').EventEmitter;
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

// TODO: send events on internal errors?
// TODO: mimic bot user when connecting as normal user
// TODO: write readme
// TODO: write docs
// TODO: saving may conflict with other instances. add locking?
class DiscordRaw extends EventEmitter {
	static get API_URL() {return 'https://discordapp.com/api';}
	static get GATEWAY_VERSION() {return 9;}

	static get ENDPOINT_GATEWAY() {return '/gateway';}

	static get OPCODE_DISPATCH() {return 0;}
	static get OPCODE_HEARTBEAT() {return 1;}
	static get OPCODE_IDENTIFY() {return 2;}
	static get OPCODE_RESUME() {return 6;}
	static get OPCODE_RECONNECT() {return 7;}
	static get OPCODE_REQUEST_GUILD_MEMBERS() {return 8;}
	static get OPCODE_INVALID_SESSION() {return 9;}
	static get OPCODE_HELLO() {return 10;}
	static get OPCODE_HEARTBEAT_ACK() {return 11;}

	static get INTENT_GUILDS() {return 1 << 0;}
	static get INTENT_GUILD_MEMBERS() {return 1 << 1;}
	static get INTENT_GUILD_BANS() {return 1 << 2;}
	static get INTENT_GUILD_EMOJIS_AND_STICKERS() {return 1 << 3;}
	static get INTENT_GUILD_INTEGRATIONS() {return 1 << 4;}
	static get INTENT_GUILD_WEBHOOKS() {return 1 << 5;}
	static get INTENT_GUILD_INVITES() {return 1 << 6;}
	static get INTENT_GUILD_VOICE_STATES() {return 1 << 7;}
	static get INTENT_GUILD_PRESENCES() {return 1 << 8;}
	static get INTENT_GUILD_MESSAGES() {return 1 << 9;}
	static get INTENT_GUILD_MESSAGE_REACTIONS() {return 1 << 10;}
	static get INTENT_GUILD_MESSAGE_TYPING() {return 1 << 11;}
	static get INTENT_DIRECT_MESSAGES() {return 1 << 12;}
	static get INTENT_DIRECT_MESSAGE_REACTIONS() {return 1 << 13;}
	static get INTENT_DIRECT_MESSAGE_TYPING() {return 1 << 14;}
	static get INTENT_GUILD_SCHEDULED_EVENTS() {return 1 << 15;}

	static get INTENTS_UNPRIVILEDGED() {return 0xFFFF & ~(DiscordRaw.INTENT_GUILD_MEMBERS | DiscordRaw.INTENT_GUILD_PRESENCES);}

	static get EVENT_CONNECT() {return 'connect';}
	static get EVENT_DISCONNECT() {return 'disconnect';}
	static get EVENT_RESUME_ERROR() {return 'resumeError';}
	static get EVENT_EVENT() {return 'event';}
	static get EVENT_RAW_EVENT() {return 'rawEvent';}

	static get LOGLEVEL_NONE() {return 0;}
	static get LOGLEVEL_ERROR() {return 1;}
	static get LOGLEVEL_INFO() {return 2;}
	static get LOGLEVEL_DEBUG() {return 3;}

	constructor(opts) {
		super();

		this._token = opts.token;
		this._shard = opts.shard === null ? undefined : (opts.shard || [0, 1]);
		this._intents = typeof(opts.intents) === 'number' ? opts.intents : DiscordRaw.INTENTS_UNPRIVILEDGED;
		this._resumeCapable = typeof(opts.resumeCapable) !== 'undefined' ? !!opts.resumeCapable : false;
		this._noResume = typeof(opts.noResume) !== 'undefined' ? !!opts.noResume : false;
		this._noFullMembers = !!opts.noFullMembers || false;
		this._logLevel = typeof(opts.logLevel) !== 'undefined' ? opts.logLevel : DiscordRaw.LOGLEVEL_ERROR;
		this._allowConnection = typeof(opts.connect) !== 'undefined' ? !!opts.connect : true;

		this._gatewayURL = null;
		this._ws = null;
		this._heartbeatInterval = null;
		this._lastHeartbeat = null;
		this._lastHeartbeatAck = null;
		this._ping = null;
		this._seq = null;
		this._session = null;
		this._authenticated = false;
		this._disconnectTime = null;
		this._dataFilePath = path.resolve('./.socket.json');
		this._guildCreateCache = {};

		this._init();
	}

	_init(retry) {
		if (this._resumeCapable && !this._noResume) {
			retry = retry || 1;

			fs.readFile(this._dataFilePath, (err, data) => {
				if (err) {
					if (err.code === 'ENOENT') {
						if (this._logLevel >= DiscordRaw.LOGLEVEL_INFO) console.info('Previous socket state doesn\'t exist');
					} else {
						if (this._logLevel >= DiscordRaw.LOGLEVEL_ERROR) {
							console.error(`Error reading previous socket state (try ${retry})`);
							console.error(err);
						}

						if (retry < 4) return setTimeout(() => this._init(retry + 1), 1000);
					}
				} else {
					try {
						data = JSON.parse(data);
					} catch (e) {
						if (this._logLevel >= DiscordRaw.LOGLEVEL_ERROR) {
							console.error('Error parsing previous socket state');
							console.error(e);
						}

						data = {};
					}

					if (!this._noResume) {
						if (this._shard) {
							this._session = data.shard && data.shard[this._shard[0]] ? data.shard[this._shard[0]].session : null;
							this._seq = data.shard && data.shard[this._shard[0]] ? data.shard[this._shard[0]].seq : null;
							this._disconnectTime = data.shard && data.shard[this._shard[0]] ? data.shard[this._shard[0]].disconnectTime : null;
						} else {
							this._session = data.session || null;
							this._seq = data.seq || null;
							this._disconnectTime = data.disconnectTime || null;
						}
					}
				}

				if (!this._session || !this._seq) this.emit(DiscordRaw.EVENT_RESUME_ERROR, {
					disconnectTime: this._disconnectTime,
				});

				this._connect();
			});
		} else {
			this.emit(DiscordRaw.EVENT_RESUME_ERROR, {
				disconnectTime: this._disconnectTime,
			});

			this._connect();
		}
	}

	_saveData(retry) {
		if (!this._resumeCapable) return;

		retry = retry || 1;

		fs.readFile(this._dataFilePath, (err, data) => {
			if (err && err.code !== 'ENOENT') {
				if (this._logLevel >= DiscordRaw.LOGLEVEL_ERROR) {
					console.error(`Error reading while saving socket state (try ${retry})`);
					console.error(err);
				}

				if (retry < 3) setTimeout(() => this._saveData(retry + 1), 1000);

				return;
			}

			try {
				data = JSON.parse(data);
			} catch (e) {
				if (this._logLevel >= DiscordRaw.LOGLEVEL_ERROR) {
					console.error('Error parsing previous socket state while saving');
					console.error(e);
				}

				data = {};
			}

			if (this._shard) {
				data.shard = data.shard || [];

				data.shard[this._shard[0]] = {
					session: this._session,
					seq: this._seq,
					disconnectTime: this._disconnectTime,
				};
			} else {
				data.session = this._session;
				data.seq = this._seq;
				data.disconnectTime = this._disconnectTime;
			}

			fs.writeFile(this._dataFilePath, JSON.stringify(data), err => {
				if (err) {
					if (this._logLevel >= DiscordRaw.LOGLEVEL_ERROR) {
						console.error(`Error saving socket state (try ${retry})`);
						console.error(err);
					}

					if (retry < 3) return setTimeout(() => this._saveData(retry + 1), 1500);
				}
			});
		});
	}

	_request(opts, callback) {
		if (typeof(opts) === 'string') opts = {endpoint: opts};

		var parsedURL = url.parse(DiscordRaw.API_URL + opts.endpoint);

		var req = https.request({
			hostname: parsedURL.hostname,
			path: parsedURL.path,
			method: opts.method || 'GET',
		}, res => {
			var body = [];

			res.on('data', d => {
				body.push(d.toString());
			});

			res.on('end', () => {
				try {
					body = JSON.parse(body.join(''));
				} catch (ex) {
					return callback(ex);
				}

				return callback(null, body);
			});
		});

		req.on('error', err => callback(err));

		req.end();
	}

	_getGatewayURL(callback) {
		if (this._gatewayURL) return callback(null, this._gatewayURL);

		this._request(DiscordRaw.ENDPOINT_GATEWAY, (err, data) => {
			if (err) return callback(err);

			this._gatewayURL = data.url + '/?encoding=json&v=' + DiscordRaw.GATEWAY_VERSION;

			return callback(null, this._gatewayURL);
		});
	}

	connect() {
		this._allowConnection = true;

		this._connect();
	}

	disconnect() {
		this._allowConnection = false;

		this._close();
	}

	isConnected() {
		return this._ws && this._ws.state === WebSocket.CONNECTED;
	}

	isAuthenticated() {
		return this.isConnected() && this._authenticated;
	}

	_connect() {
		if (this._ws || !this._allowConnection) return;

		this._getGatewayURL((err, url) => {
			if (err) {
				if (this._logLevel >= DiscordRaw.LOGLEVEL_ERROR) {
					console.error('Error getting gateway URL');
					console.error(err);
				}

				return setTimeout(() => this._connect(), 2500);
			}

			this._ws = new WebSocket(url);

			this._ws.on('open', () => {
				this.emit(DiscordRaw.EVENT_CONNECT);
			});

			this._ws.on('close', closeCode => {
				this._ws = null;

				clearInterval(this._heartbeatInterval);
				this._heartbeatInterval = null;

				this._disconnectTime = Date.now();

				if (this._logLevel >= DiscordRaw.LOGLEVEL_INFO) console.info(`WebSocket disconnected (${closeCode})`);

				this.emit(DiscordRaw.EVENT_DISCONNECT, {
					code: closeCode,
				});

				this._saveData();

				this._connect();
			});

			this._ws.on('message', (msg, flags) => {
				if (flags.binary) {
					zlib.inflate(msg, (err, data) => {
						if (err) {
							if (this._logLevel >= DiscordRaw.LOGLEVEL_ERROR) {
								console.error('Error deflating a message');
								console.error(err);
							}

							return this._close();
						}

						this._handleMessage(JSON.parse(data));
					});
				} else {
					this._handleMessage(JSON.parse(msg));
				}
			});
		});
	}

	_close() {
		this._authenticated = false;

		if (this._ws) this._ws.close();
	}

	_handleMessage(event) {
		if (this._logLevel >= DiscordRaw.LOGLEVEL_DEBUG) console.log('<', event);

		this.emit(DiscordRaw.EVENT_RAW_EVENT, event);

		switch (event.op) {
			case DiscordRaw.OPCODE_DISPATCH:
				this._seq = event.s;

				if (event.t === 'READY') {
					this._session = event.d.session_id;

					this._authenticated = true;

					this._saveData();
				}

				if (event.t === 'RESUMED') this._authenticated = true;

				if (!this._noFullMembers && event.t === 'GUILD_MEMBERS_CHUNK' && this._guildCreateCache[event.d.guild_id]) {
					var guildCreate = this._guildCreateCache[event.d.guild_id];
					guildCreate.members = event.d.members;

					this.emit(DiscordRaw.EVENT_EVENT, {
						t: guildCreate.t,
						d: guildCreate.d,
					});

					return;
				}

				if (!this._noFullMembers && event.t === 'GUILD_CREATE' && event.d.large) {
					this._guildCreateCache[event.d.id] = event;

					this.send({
						op: DiscordRaw.OPCODE_REQUEST_GUILD_MEMBERS,
						d: {
							guild_id: event.d.id,
							query: '',
							limit: 0,
						},
					});
				} else {
					this.emit(DiscordRaw.EVENT_EVENT, {
						t: event.t,
						d: event.d,
					});
				}

				break;
			case DiscordRaw.OPCODE_HEARTBEAT:
				this._sendHeartbeat();
				break;
			case DiscordRaw.OPCODE_RECONNECT:
				this._close();
				break;
			case DiscordRaw.OPCODE_INVALID_SESSION:
				this._authenticated = false;

				if (!event.d) {
					this._seq = null;
					this._session = null;

					this.emit(DiscordRaw.EVENT_RESUME_ERROR, {
						disconnectTime: this._disconnectTime,
					});
				}

				this._sendIdentify();

				break;
			case DiscordRaw.OPCODE_HELLO:
				this._heartbeatInterval = setInterval(() => this._sendHeartbeat(), event.d.heartbeat_interval);

				this._sendIdentify();

				break;
			case DiscordRaw.OPCODE_HEARTBEAT_ACK:
				this._lastHeartbeatAck = Date.now();

				this._ping = this._lastHeartbeatAck - this._lastHeartbeat;

				break;
		}
	}

	_sendIdentify() {
		if (this._seq && this._session) {
			if (this._logLevel >= DiscordRaw.LOGLEVEL_INFO) console.info('Resuming WebSocket connection');

			this.send({
				op: DiscordRaw.OPCODE_RESUME,
				d: {
					token: this._token,
					session_id: this._session,
					seq: this._seq,
				},
			});
		} else {
			if (this._logLevel >= DiscordRaw.LOGLEVEL_INFO) console.info('Authenticating WebSocket connection');

			this.send({
				op: DiscordRaw.OPCODE_IDENTIFY,
				d: {
					token: this._token,
					properties: {
						$browser: 'discord-raw',
					},
					compress: true,
					large_threshold: 250,
					shard: this._shard,
					intents: this._intents,
				},
			});
		}
	}

	_sendHeartbeat() {
		this.send({
			op: DiscordRaw.OPCODE_HEARTBEAT,
			d: this._seq,
		});

		this._lastHeartbeat = Date.now();
	}

	send(msg) {
		if (!this.isConnected()) return false;

		if (this._logLevel >= DiscordRaw.LOGLEVEL_DEBUG) console.log('>', msg);

		this._ws.send(JSON.stringify(msg), err => {
			if (err) {
				if (this._logLevel >= DiscordRaw.LOGLEVEL_ERROR) {
					console.error('Error sending a message');
					console.error(msg);
					console.error(err);
				}
			}
		});

		return true;
	}
}

module.exports = DiscordRaw;
