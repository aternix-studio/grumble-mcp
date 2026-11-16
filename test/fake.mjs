// A pretend Grumble desktop app (its local connection, as desktop/src-tauri/src/rpc.rs and
// app/src/features/localApps speak it) and a pretend Discord on the connection before it, plus a pretend token
// endpoint that checks PKCE: enough for grumble-mcp to be driven from end to end.
import net from "node:net";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import {createHash} from "node:crypto";

const frame = (op, body) => {
	const json = Buffer.from(JSON.stringify(body));
	const head = Buffer.alloc(8);
	head.writeUInt32LE(op, 0);
	head.writeUInt32LE(json.length, 4);
	return Buffer.concat([head, json]);
};

function frames(socket, on) {
	let buf = Buffer.alloc(0);
	socket.on("data", (c) => {
		buf = Buffer.concat([buf, c]);
		while (buf.length >= 8) {
			const len = buf.readUInt32LE(4);
			if (buf.length < 8 + len) return;
			on(buf.readUInt32LE(0), JSON.parse(buf.subarray(8, 8 + len).toString()));
			buf = buf.subarray(8 + len);
		}
	});
}

export async function fakeGrumble(dir) {
	fs.mkdirSync(dir, {recursive: true});
	for (const f of fs.readdirSync(dir)) if (f.startsWith("discord-ipc-")) fs.rmSync(path.join(dir, f));
	const seen = {authorize: 0, challenges: [], commands: [], args: {}};
	// each token's scopes; `grant` (when set) is what the next AUTHORIZE grants, whatever's asked; `refuse` says no to
	// it; `old` is a Grumble before its own commands
	const tokens = new Map();
	const how = {grant: null, refuse: false, old: false};
	let code = null;
	const me = {id: "42", username: "wren", global_name: "Wren", discriminator: "0", avatar: null, bot: false};
	const sockets = new Set();

	// Discord, on discord-ipc-0: says it's Discord
	const discord = net.createServer((s) => frames(s, (op) => op === 0 && s.write(frame(1, {cmd: "DISPATCH", evt: "READY", data: {v: 1, config: {api_endpoint: "//discord.com/api"}, user: me}}))));
	discord.listen(path.join(dir, "discord-ipc-0"));
	const grumble = net.createServer((s) => {
		sockets.add(s);
		s.on("close", () => sockets.delete(s));
		let scopes = [];
		frames(s, (op, f) => {
			if (op === 0) return s.write(frame(1, {cmd: "DISPATCH", evt: "READY", nonce: null, data: {v: 1, config: {cdn_host: "", api_endpoint: "", environment: "production"}, user: me}}));
			seen.commands.push(f.cmd);
			const reply = (data) => s.write(frame(1, {cmd: f.cmd, evt: null, nonce: f.nonce, data}));
			const refuse = (code, message) => s.write(frame(1, {cmd: f.cmd, evt: "ERROR", nonce: f.nonce, data: {code, message}}));
			const a = f.args ?? {};
			switch (f.cmd) {
				case "AUTHORIZE":
					seen.authorize++;
					seen.challenges.push({challenge: a.code_challenge, method: a.code_challenge_method, scopes: a.scopes});
					if (how.refuse) return refuse(5000, "OAuth2 Error: access_denied");
					code = {value: `code-${seen.authorize}`, challenge: a.code_challenge, scopes: how.grant ?? a.scopes};
					return reply({code: code.value});
				case "AUTHENTICATE":
					if (!tokens.has(a.access_token)) return refuse(4009, "Invalid access token");
					scopes = tokens.get(a.access_token);
					return reply({user: me, scopes, expires: new Date(Date.now() + 6e8).toISOString(), application: {id: "123", name: "Grumble for coding agents"}});
				case "GET_GUILDS":
					return reply({guilds: [{id: "100", name: "Night Owls", icon_url: null}]});
				case "GET_CHANNELS":
					if (a.guild_id === "@me") return reply({channels: [{id: "500", name: "Squish", type: 1}]});
					if (a.guild_id !== "100") return refuse(4003, "Invalid guild id");
					return reply({channels: [{id: "200", name: "general", type: 0}, {id: "201", name: "Lounge", type: 2}]});
				case "GET_CHANNEL":
					return reply({
						id: a.channel_id,
						name: a.channel_id === "500" ? "" : "general",
						type: a.channel_id === "500" ? 1 : 0,
						messages: [
							{id: "1", content: "morning", author: me, timestamp: "2026-11-11T08:00:00.000Z", attachments: []},
							{id: "2", content: "look at this", author: {id: "7", username: "squish_mishu", global_name: "Squish"}, timestamp: "2026-11-11T08:01:00.000Z", attachments: [{filename: "building.mp4"}]},
						],
					});
				case "SUBSCRIBE":
					reply({evt: f.evt});
					if (f.evt === "MESSAGE_CREATE")
						setTimeout(() => s.write(frame(1, {cmd: "DISPATCH", evt: "MESSAGE_CREATE", data: {channel_id: a.channel_id, message: {id: "3", content: "new one", author: me, timestamp: "2026-11-11T08:02:00.000Z"}}})), 50);
					if (f.evt === "NOTIFICATION_CREATE") setTimeout(() => s.write(frame(1, {cmd: "DISPATCH", evt: "NOTIFICATION_CREATE", data: {title: "Squish", body: "are you on?"}})), 50);
					return;
				case "SELECT_TEXT_CHANNEL":
					return reply({id: a.channel_id});
				case "SELECT_VOICE_CHANNEL":
					return reply(a.channel_id ? {id: a.channel_id} : null);
				case "GET_SELECTED_VOICE_CHANNEL":
					return reply({id: "201", name: "Lounge", voice_states: [{nick: "Squish", user: {id: "7", username: "squish_mishu"}}]});
				case "GET_VOICE_SETTINGS":
					return reply({mute: false, deaf: false});
				case "SET_VOICE_SETTINGS":
					return reply({mute: !!a.mute, deaf: !!a.deaf});
			}
			// Grumble's own
			const ours = {GET_UNREAD: "rpc", SEARCH_MESSAGES: "messages.read", DRAFT_MESSAGE: "messages.draft", GET_STATUS: "rpc", SET_STATUS: "rpc.status.write", CREATE_CREATION: "creations.write", GET_CREATIONS: "creations.write", OPEN_CREATION: "creations.write"};
			if (f.cmd in ours && !how.old) {
				if (!scopes.includes(ours[f.cmd])) return refuse(4006, "Not authenticated or invalid scope");
				seen.args[f.cmd] = a;
				switch (f.cmd) {
					case "GET_UNREAD":
						return reply({channels: [{id: "200", name: "general", type: 0, guild_id: "100", guild_name: "Night Owls", mentions: 2, muted: false}, {id: "500", name: "Squish", type: 1, guild_id: null, guild_name: null, mentions: 0, muted: true}]});
					case "SEARCH_MESSAGES":
						return reply({total: 1, messages: [{id: "9", channel_id: "200", channel_name: "general", content: "the build passed", author: me, timestamp: "2026-11-10T09:00:00.000Z", attachments: []}]});
					case "DRAFT_MESSAGE":
						return reply({channel_id: a.channel_id, drafted: true, files: (a.files ?? []).length});
					case "GET_STATUS":
						return reply({status: "online", custom_status: null});
					case "SET_STATUS":
						return reply({status: a.status ?? "online", custom_status: a.custom_status ? {text: a.custom_status} : null});
					case "CREATE_CREATION":
						return reply({id: "77", kind: a.kind, name: a.name, description: a.description, status: "draft"});
					case "GET_CREATIONS":
						return reply({creations: [{id: "77", kind: "theme", name: "Ember Night", status: "draft"}, {id: "78", kind: "decoration", name: "Leaf Ring", status: "pending", review_note: null}]});
					case "OPEN_CREATION":
						return reply({id: a.id, kind: "theme", name: "Ember Night", status: "draft"});
				}
			}
			refuse(4002, `Unknown command: ${f.cmd}`);
		});
	});
	grumble.listen(path.join(dir, "discord-ipc-1"));

	// the server's token endpoint: a code with its verifier (PKCE), or a refresh, and no secret
	const api = http.createServer((req, res) => {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			const f = Object.fromEntries(new URLSearchParams(body));
			const ok = (t, scopes) => (tokens.set(t.access_token, scopes), res.writeHead(200, {"Content-Type": "application/json"}).end(JSON.stringify({...t, token_type: "Bearer", expires_in: 604800})));
			const no = () => res.writeHead(400, {"Content-Type": "application/json"}).end(JSON.stringify({error: "invalid_grant"}));
			if (req.url !== "/api/v9/oauth2/token" || f.client_id !== "123" || f.client_secret) return no();
			if (f.grant_type === "authorization_code") {
				const right = code && f.code === code.value && createHash("sha256").update(f.code_verifier ?? "").digest("base64url") === code.challenge;
				return right ? ok({access_token: `access-${code.value}`, refresh_token: `refresh-${code.value}`, scope: code.scopes.join(" ")}, code.scopes) : no();
			}
			if (f.grant_type === "refresh_token" && f.refresh_token?.startsWith("refresh-")) return ok({access_token: `${f.refresh_token}-again`, refresh_token: `${f.refresh_token}-r`, scope: ""}, code?.scopes ?? []);
			no();
		});
	});
	await new Promise((r) => api.listen(0, "127.0.0.1", r));
	return {
		seen,
		how,
		url: `http://127.0.0.1:${api.address().port}`,
		dropEveryone: () => sockets.forEach((s) => s.destroy()),
		close: () => (discord.close(), grumble.close(), api.close(), sockets.forEach((s) => s.destroy())),
	};
}
