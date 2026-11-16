// Signing in to Grumble as you, once. Grumble asks you in its own window what this tool may do; say yes and the tool
// gets a code, which it swaps for a token with PKCE (it keeps no secret: the app it signs in as is a public client).
// The token's kept on this computer, readable only by you, so you're asked again only if you take it back (Settings,
// Authorised apps) or don't use it for a month.
import {createHash, randomBytes} from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** What it asks for: who you are, your servers, channels and messages, your voice and your notifications; messages
 * drafted for you to send (never sent by it), your status, and themes and cosmetics made for you. */
export const SCOPES = [
	"identify",
	"rpc",
	"messages.read",
	"rpc.voice.read",
	"rpc.voice.write",
	"rpc.notifications.read",
	"messages.draft",
	"rpc.status.write",
	"creations.write",
];

const folder = () =>
	process.platform === "win32"
		? path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "grumble-mcp")
		: path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "grumble-mcp");
const file = (server, clientId) => path.join(folder(), `${new URL(server).host.replace(/[^a-z0-9.-]/gi, "_")}-${clientId}.json`);

async function load(server, clientId) {
	try {
		return JSON.parse(await fs.readFile(file(server, clientId), "utf8"));
	} catch {
		return null;
	}
}

async function save(server, clientId, tokens) {
	await fs.mkdir(folder(), {recursive: true, mode: 0o700});
	const kept = {access_token: tokens.access_token, refresh_token: tokens.refresh_token, expires_at: Date.now() + (tokens.expires_in ?? 0) * 1000, scope: tokens.scope, asked: tokens.asked};
	await fs.writeFile(file(server, clientId), JSON.stringify(kept), {mode: 0o600});
	return kept;
}

/** Forgets the saved token (it was refused). */
export const forget = (server, clientId) => fs.rm(file(server, clientId), {force: true});

async function exchange(server, form) {
	const res = await fetch(`${server.replace(/\/+$/, "")}/api/v9/oauth2/token`, {
		method: "POST",
		headers: {"Content-Type": "application/x-www-form-urlencoded"},
		body: new URLSearchParams(form).toString(),
	});
	const body = await res.json().catch(() => ({}));
	if (!res.ok || !body.access_token) throw new Error(`Grumble wouldn't sign this tool in: ${body.error_description ?? body.error ?? res.status}`);
	return body;
}

/** PKCE (RFC 7636): a value kept here, and its SHA-256 sent with the request. */
export function pkce() {
	const verifier = randomBytes(32).toString("base64url");
	return {verifier, challenge: createHash("sha256").update(verifier).digest("base64url")};
}

/** Asks you in Grumble's window, and signs in with what you allow. */
async function ask(conn, {clientId, server, scopes}) {
	const {verifier, challenge} = pkce();
	// (you have five minutes to answer in Grumble's window)
	const {code} = await conn.request("AUTHORIZE", {client_id: clientId, scopes, code_challenge: challenge, code_challenge_method: "S256"}, {timeout: 300_000});
	const kept = await save(server, clientId, {...(await exchange(server, {grant_type: "authorization_code", code, client_id: clientId, code_verifier: verifier})), asked: scopes});
	return conn.request("AUTHENTICATE", {access_token: kept.access_token});
}

/** Signs `conn` in as you: with the saved token, a refreshed one, or by asking you in Grumble. Returns what Grumble
 * says the tool may do ({user, scopes, ...}). Signed in before this tool could do more, it asks you once about the
 * new things; say no and it carries on with what you'd allowed, and doesn't ask again. */
export async function signIn(conn, {clientId, server, scopes = SCOPES}) {
	const saved = await load(server, clientId);
	let granted = null;
	if (saved?.access_token && saved.expires_at > Date.now() + 60_000) {
		try {
			granted = await conn.request("AUTHENTICATE", {access_token: saved.access_token});
		} catch {}
	}
	if (!granted && saved?.refresh_token) {
		try {
			const kept = await save(server, clientId, {...(await exchange(server, {grant_type: "refresh_token", refresh_token: saved.refresh_token, client_id: clientId})), asked: saved.asked});
			granted = await conn.request("AUTHENTICATE", {access_token: kept.access_token});
		} catch {}
	}
	if (granted) {
		const asked = new Set(saved?.asked ?? granted.scopes ?? []);
		if (!scopes.some((s) => !asked.has(s))) return granted;
		try {
			return await ask(conn, {clientId, server, scopes});
		} catch {
			// (said no, or didn't answer: what was allowed before stands, and it isn't asked again)
			const now = await load(server, clientId);
			if (now) await fs.writeFile(file(server, clientId), JSON.stringify({...now, asked: scopes}), {mode: 0o600});
			return granted;
		}
	}
	await forget(server, clientId);
	return ask(conn, {clientId, server, scopes});
}
