// Grumble's desktop app, over its local connection: the one Discord's RPC uses (a named pipe on Windows, a socket
// elsewhere, called discord-ipc-0 to -9), so its framing and commands are Discord's. Discord may be running and hold
// some of them; Grumble's is the one whose greeting has no API address of Discord's (its READY says "grumble", or an
// empty api_endpoint where Discord's says //discord.com/api).
import net from "node:net";
import path from "node:path";
import {EventEmitter} from "node:events";
import {randomUUID} from "node:crypto";

const HANDSHAKE = 0;
const FRAME = 1;
const CLOSE = 2;
const PING = 3;
const PONG = 4;

/** Where connection `i` is (as the desktop app makes it: desktop/src-tauri/src/rpc.rs). */
export function pipeName(i) {
	if (process.platform === "win32") return `\\\\?\\pipe\\discord-ipc-${i}`;
	const dir = ["XDG_RUNTIME_DIR", "TMPDIR", "TMP", "TEMP"].map((v) => process.env[v]).find(Boolean) ?? "/tmp";
	return path.join(dir, `discord-ipc-${i}`);
}

const encode = (op, body) => {
	const json = Buffer.from(JSON.stringify(body));
	const head = Buffer.alloc(8);
	head.writeUInt32LE(op, 0);
	head.writeUInt32LE(json.length, 4);
	return Buffer.concat([head, json]);
};

/** Whether a READY came from Grumble rather than Discord. */
export const isGrumble = (ready) => !!ready && (ready.grumble !== undefined || ready.config?.api_endpoint === "");

export class Connection extends EventEmitter {
	#socket;
	#buffer = Buffer.alloc(0);
	#pending = new Map();
	ready = null;

	constructor(socket) {
		super();
		this.#socket = socket;
		socket.on("data", (chunk) => this.#read(chunk));
		socket.on("close", () => {
			for (const {fail} of this.#pending.values()) fail(new Error("Grumble closed the connection."));
			this.#pending.clear();
			this.emit("close");
		});
		socket.on("error", () => {});
	}

	/** Connects to Grumble's desktop app as `clientId` (an application's id), trying each connection in turn. */
	static async open(clientId, {wait = 2000} = {}) {
		for (let i = 0; i < 10; i++) {
			const socket = await new Promise((done) => {
				const s = net.connect(pipeName(i));
				s.once("connect", () => done(s));
				s.once("error", () => done(null));
			});
			if (!socket) continue;
			const conn = new Connection(socket);
			const ready = await new Promise((done) => {
				const timer = setTimeout(() => done(null), wait);
				conn.once("dispatch", (evt, data) => (clearTimeout(timer), done(evt === "READY" ? data : null)));
				conn.once("close", () => (clearTimeout(timer), done(null)));
				conn.#send(HANDSHAKE, {v: 1, client_id: clientId});
			});
			if (isGrumble(ready)) {
				conn.ready = ready;
				return conn;
			}
			conn.close();
		}
		throw new Error("Grumble's desktop app isn't running on this computer (or is too old to be connected to). Open it and try again.");
	}

	#send(op, body) {
		this.#socket.write(encode(op, body));
	}

	#read(chunk) {
		this.#buffer = Buffer.concat([this.#buffer, chunk]);
		while (this.#buffer.length >= 8) {
			const op = this.#buffer.readUInt32LE(0);
			const len = this.#buffer.readUInt32LE(4);
			if (this.#buffer.length < 8 + len) return;
			let body = null;
			try {
				body = JSON.parse(this.#buffer.subarray(8, 8 + len).toString("utf8"));
			} catch {}
			this.#buffer = this.#buffer.subarray(8 + len);
			if (op === PING) this.#send(PONG, body);
			else if (op === CLOSE) this.close();
			else if (op === FRAME && body) this.#frame(body);
		}
	}

	#frame(f) {
		if (f.cmd === "DISPATCH") return void this.emit("dispatch", f.evt, f.data);
		const waiting = f.nonce && this.#pending.get(f.nonce);
		if (!waiting) return;
		this.#pending.delete(f.nonce);
		if (f.evt === "ERROR") waiting.fail(Object.assign(new Error(f.data?.message ?? "Grumble refused that."), {code: f.data?.code}));
		else waiting.done(f.data);
	}

	/** Sends a command and waits for its answer (`evt` for SUBSCRIBE); refused, it throws with Grumble's reason. */
	request(cmd, args = {}, {evt, timeout = 15000} = {}) {
		const nonce = randomUUID();
		return new Promise((done, fail) => {
			const timer = setTimeout(() => {
				this.#pending.delete(nonce);
				fail(new Error(`Grumble didn't answer ${cmd}.`));
			}, timeout);
			this.#pending.set(nonce, {done: (v) => (clearTimeout(timer), done(v)), fail: (e) => (clearTimeout(timer), fail(e))});
			this.#send(FRAME, {cmd, args, nonce, ...(evt ? {evt} : {})});
		});
	}

	close() {
		this.#socket.destroy();
	}
}
