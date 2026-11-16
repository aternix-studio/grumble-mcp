// One connection to Grumble's desktop app, made when a tool first needs it and made again if it's lost (the app
// closed or restarted), signed in as you. New messages in the channels it's watching, and your notifications, are
// kept here until a tool reads them.
import {Connection} from "./ipc.js";
import {forget, signIn} from "./auth.js";

const KEEP = 500;

export class Grumble {
	#conn = null;
	#opening = null;
	granted = null;
	messages = [];
	notifications = [];
	watched = new Set();

	constructor({clientId, server}) {
		this.clientId = clientId;
		this.server = server;
	}

	/** The signed-in connection, opened if need be. */
	async conn() {
		if (this.#conn) return this.#conn;
		this.#opening ??= this.#open().finally(() => (this.#opening = null));
		return this.#opening;
	}

	async #open() {
		const conn = await Connection.open(this.clientId);
		try {
			this.granted = await signIn(conn, {clientId: this.clientId, server: this.server});
		} catch (e) {
			conn.close();
			if (e?.code === 4009) await forget(this.server, this.clientId);
			throw e;
		}
		conn.on("dispatch", (evt, data) => {
			if (evt === "MESSAGE_CREATE" && data?.message) {
				this.messages.push({channel_id: data.channel_id, message: data.message});
				if (this.messages.length > KEEP) this.messages.shift();
			} else if (evt === "NOTIFICATION_CREATE" && data) {
				this.notifications.push({at: new Date().toISOString(), title: data.title, body: data.body, channel_id: data.channel_id ?? null});
				if (this.notifications.length > KEEP) this.notifications.shift();
			}
		});
		conn.on("close", () => {
			if (this.#conn === conn) this.#conn = null;
		});
		this.#conn = conn;
		if (this.may("rpc.notifications.read")) await conn.request("SUBSCRIBE", {}, {evt: "NOTIFICATION_CREATE"}).catch(() => {});
		// (watched again after a reconnect)
		for (const id of this.watched) await conn.request("SUBSCRIBE", {channel_id: id}, {evt: "MESSAGE_CREATE"}).catch(() => {});
		return conn;
	}

	/** Whether you let it do `scope`. */
	may(scope) {
		return !!this.granted?.scopes?.includes(scope);
	}

	/** A command, as you. */
	async ask(cmd, args = {}, opts = {}) {
		return (await this.conn()).request(cmd, args, opts);
	}

	async watch(channelId, on) {
		const conn = await this.conn();
		if (on) {
			await conn.request("SUBSCRIBE", {channel_id: channelId}, {evt: "MESSAGE_CREATE"});
			this.watched.add(channelId);
		} else {
			await conn.request("UNSUBSCRIBE", {channel_id: channelId}, {evt: "MESSAGE_CREATE"}).catch(() => {});
			this.watched.delete(channelId);
		}
	}

	close() {
		this.#conn?.close();
	}
}
