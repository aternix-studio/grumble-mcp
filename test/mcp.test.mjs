// grumble-mcp from end to end: an MCP client (as a coding agent is) starts it and uses each tool, against a pretend
// Grumble desktop app (test/fake.mjs), with a pretend Discord on the connection before Grumble's.
import {test} from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StdioClientTransport} from "@modelcontextprotocol/sdk/client/stdio.js";
import {fakeGrumble} from "./fake.mjs";

const here = path.dirname(new URL(import.meta.url).pathname);
const run = path.join(here, ".run");
const config = path.join(run, "config");

async function agent(fake) {
	const client = new Client({name: "test-agent", version: "1"});
	await client.connect(
		new StdioClientTransport({
			command: process.execPath,
			args: [path.join(here, "..", "src", "index.js")],
			env: {...process.env, XDG_RUNTIME_DIR: run, XDG_CONFIG_HOME: config, GRUMBLE_SERVER: fake.url, GRUMBLE_CLIENT_ID: "123"},
		}),
	);
	const call = async (name, args = {}) => {
		const r = await client.callTool({name, arguments: args});
		return {text: r.content.map((c) => c.text).join("\n"), error: !!r.isError};
	};
	return {client, call};
}

test("a coding agent uses Grumble through grumble-mcp", async () => {
	fs.rmSync(config, {recursive: true, force: true});
	const fake = await fakeGrumble(run);
	try {
		const {client, call} = await agent(fake);
		const {tools} = await client.listTools();
		assert.deepEqual(
			tools.map((t) => t.name).sort(),
			[
				"grumble_channels",
				"grumble_draft",
				"grumble_join_voice",
				"grumble_leave_voice",
				"grumble_make_cosmetic",
				"grumble_make_filter",
				"grumble_make_theme",
				"grumble_my_creations",
				"grumble_new_messages",
				"grumble_notifications",
				"grumble_open",
				"grumble_open_creation",
				"grumble_read",
				"grumble_search",
				"grumble_servers",
				"grumble_set_status",
				"grumble_set_voice",
				"grumble_status",
				"grumble_unread",
				"grumble_voice",
				"grumble_watch",
				"grumble_whoami",
			],
		);

		// signed in once, past Discord, with PKCE (S256) and no secret
		const who = await call("grumble_whoami");
		assert.match(who.text, /Signed in as Wren \(@wren\)/);
		assert.equal(fake.seen.authorize, 1);
		assert.equal(fake.seen.challenges[0].method, "S256");
		assert.equal(fake.seen.challenges[0].challenge.length, 43);
		assert.deepEqual(fake.seen.challenges[0].scopes, ["identify", "rpc", "messages.read", "rpc.voice.read", "rpc.voice.write", "rpc.notifications.read", "messages.draft", "rpc.status.write", "creations.write"]);
		// the token's kept for you alone
		const saved = fs.readdirSync(path.join(config, "grumble-mcp"));
		assert.equal(saved.length, 1);
		assert.equal(fs.statSync(path.join(config, "grumble-mcp", saved[0])).mode & 0o777, 0o600);

		assert.match((await call("grumble_servers")).text, /100 {2}Night Owls/);
		assert.match((await call("grumble_channels", {server_id: "100"})).text, /200 {2}text {2}general\n201 {2}voice {2}Lounge/);
		assert.match((await call("grumble_channels", {server_id: "@me"})).text, /500 {2}DM {2}Squish/);
		const read = await call("grumble_read", {channel_id: "200"});
		assert.match(read.text, /\[2026-11-11 08:00\] Wren \(@wren\): morning/);
		assert.match(read.text, /Squish \(@squish_mishu\): look at this \[attached: building\.mp4\]/);
		assert.match((await call("grumble_read", {channel_id: "200", limit: 1})).text, /look at this/);
		assert.equal((await call("grumble_read", {channel_id: "abc"})).error, true, "ids are checked");

		// watching: new messages kept until asked for
		assert.match((await call("grumble_new_messages")).text, /nothing's being watched/);
		await call("grumble_watch", {channel_id: "200"});
		await new Promise((r) => setTimeout(r, 150));
		assert.match((await call("grumble_new_messages")).text, /\(200\) .*new one/);
		assert.match((await call("grumble_new_messages")).text, /^Nothing new\.$/);
		assert.match((await call("grumble_notifications")).text, /Squish: are you on\?/);

		assert.match((await call("grumble_voice")).text, /In Lounge \(201\) with Squish\. You're not muted\./);
		assert.match((await call("grumble_join_voice", {channel_id: "201"})).text, /Joined/);
		assert.match((await call("grumble_set_voice", {mute: true})).text, /You're muted/);
		assert.match((await call("grumble_leave_voice")).text, /Left voice/);
		assert.match((await call("grumble_open", {channel_id: "500"})).text, /Opened/);

		// further back, what's unread, and search
		assert.match((await call("grumble_read", {channel_id: "200", before: "2"})).text, /morning \(1\)/);
		assert.equal(fake.seen.commands.includes("GET_CHANNEL"), true);
		const unread = (await call("grumble_unread")).text;
		assert.match(unread, /200 {2}Night Owls #general {2}2 mentions/);
		assert.match(unread, /500 {2}Squish {2}\(muted\)/);
		const found = await call("grumble_search", {query: "build from:wren", server_id: "100"});
		assert.match(found.text, /1 found \(page 1 of 1\):\n#general .*the build passed \(9 in 200\)/);
		assert.deepEqual(fake.seen.args.SEARCH_MESSAGES, {query: "build from:wren", guild_id: "100", page: 0});

		// a message drafted for you to send, with a file: never sent
		const notes = path.join(run, "notes.txt");
		fs.writeFileSync(notes, "hello");
		const drafted = await call("grumble_draft", {channel_id: "500", content: "on my way", files: [notes]});
		assert.match(drafted.text, /in the message box in Grumble, with 1 file, for you to send/);
		assert.deepEqual(fake.seen.args.DRAFT_MESSAGE.files, [{name: "notes.txt", type: "text/plain", data: Buffer.from("hello").toString("base64")}]);
		assert.equal(fake.seen.commands.some((c) => /SEND|CREATE_MESSAGE/.test(c)), false, "nothing's sent");

		// your status
		assert.match((await call("grumble_status")).text, /You're online\./);
		assert.match((await call("grumble_set_status", {status: "dnd", custom_status: "deep in a build"})).text, /You're on do not disturb, with "deep in a build"\./);

		// themes and cosmetics, made for you
		const theme = await call("grumble_make_theme", {name: "Ember Night", colors: {accent: "#e07a5f", background: "#2b2a33", panel: "#24232b", rail: "#1c1b22", text: "#eceaf2"}});
		assert.match(theme.text, /Made "Ember Night" \(theme, 77\), saved as yours/);
		assert.equal((await call("grumble_make_theme", {name: "Bad", colors: {accent: "orange"}})).error, true, "colours are checked");
		assert.match((await call("grumble_make_filter", {name: "Golden Hour", settings: {warmth: 0.4, vignette: 0.2}})).text, /Made "Golden Hour" \(filter/);
		const png = path.join(run, "ring.png");
		fs.writeFileSync(png, Buffer.from("89504e470d0a1a0a", "hex"));
		assert.match((await call("grumble_make_cosmetic", {kind: "decoration", name: "Leaf Ring", file: png})).text, /Made "Leaf Ring" \(decoration/);
		assert.equal(fake.seen.args.CREATE_CREATION.image, `data:image/png;base64,${Buffer.from("89504e470d0a1a0a", "hex").toString("base64")}`);
		assert.match((await call("grumble_make_cosmetic", {kind: "decoration", name: "Notes", file: notes})).text, /has to be a PNG, JPEG, GIF or WebP/);
		const mine = (await call("grumble_my_creations")).text;
		assert.match(mine, /77 {2}theme {2}Ember Night {2}\(only yours\)/);
		assert.match(mine, /78 {2}decoration {2}Leaf Ring {2}\(waiting for the safety team's look\)/);
		assert.match((await call("grumble_open_creation", {id: "77"})).text, /Showing "Ember Night" in Grumble/);

		// Grumble restarted: it connects again by itself, with the same sign-in, watching what it watched
		fake.dropEveryone();
		await new Promise((r) => setTimeout(r, 100));
		assert.match((await call("grumble_servers")).text, /Night Owls/);
		assert.equal(fake.seen.authorize, 1, "not asked again");
		await client.close();

		// a new run of the tool: the saved sign-in, no question
		const again = await agent(fake);
		assert.match((await again.call("grumble_whoami")).text, /Signed in as Wren/);
		assert.equal(fake.seen.authorize, 1, "not asked again");
		await again.client.close();
	} finally {
		fake.close();
	}
});

// Signed in by a version that could do less: asked once about the new things; said no to, it carries on with what was
// allowed and doesn't ask again. And an older Grumble that doesn't know its own commands yet says to update.
test("new permissions are asked for once, and an older Grumble is told to update", async () => {
	fs.rmSync(config, {recursive: true, force: true});
	const fake = await fakeGrumble(run);
	const OLD = ["identify", "rpc", "messages.read", "rpc.voice.read", "rpc.voice.write", "rpc.notifications.read"];
	const signedInBefore = () => {
		const dir = path.join(config, "grumble-mcp");
		const f = path.join(dir, fs.readdirSync(dir)[0]);
		const kept = JSON.parse(fs.readFileSync(f, "utf8"));
		delete kept.asked;
		fs.writeFileSync(f, JSON.stringify(kept));
	};
	try {
		// signed in when the tool asked for less
		fake.how.grant = OLD;
		let a = await agent(fake);
		await a.call("grumble_whoami");
		await a.client.close();
		signedInBefore();
		assert.equal(fake.seen.authorize, 1);

		// the new version asks once, gets all, and its new tools work
		fake.how.grant = null;
		a = await agent(fake);
		assert.match((await a.call("grumble_whoami")).text, /creations\.write/);
		assert.equal(fake.seen.authorize, 2);
		assert.match((await a.call("grumble_unread")).text, /Night Owls/);
		await a.client.close();

		// said no to: what was allowed stands, the new tools say so, and it isn't asked again
		fake.how.grant = OLD;
		fs.rmSync(config, {recursive: true, force: true});
		a = await agent(fake);
		await a.call("grumble_whoami");
		await a.client.close();
		signedInBefore();
		fake.how.refuse = true;
		a = await agent(fake);
		assert.match((await a.call("grumble_servers")).text, /Night Owls/);
		assert.match((await a.call("grumble_make_theme", {name: "Ember", colors: {accent: "#e07a5f", background: "#2b2a33", panel: "#24232b", rail: "#1c1b22", text: "#eceaf2"}})).text, /didn't let this tool make themes/);
		await a.client.close();
		const asked = fake.seen.authorize;
		a = await agent(fake);
		await a.call("grumble_servers");
		assert.equal(fake.seen.authorize, asked, "not asked again");
		await a.client.close();

		// an older Grumble
		fake.how.refuse = false;
		fake.how.grant = null;
		fs.rmSync(config, {recursive: true, force: true});
		fake.how.old = true;
		a = await agent(fake);
		const r = await a.call("grumble_unread");
		assert.equal(r.error, true);
		assert.match(r.text, /needs a newer Grumble/);
		await a.client.close();
	} finally {
		fake.close();
	}
});

test("without Grumble running, it says so plainly", async () => {
	fs.rmSync(config, {recursive: true, force: true});
	const empty = path.join(run, "empty");
	fs.mkdirSync(empty, {recursive: true});
	const client = new Client({name: "test-agent", version: "1"});
	await client.connect(
		new StdioClientTransport({
			command: process.execPath,
			args: [path.join(here, "..", "src", "index.js")],
			env: {...process.env, XDG_RUNTIME_DIR: empty, XDG_CONFIG_HOME: config, GRUMBLE_SERVER: "http://127.0.0.1:9", GRUMBLE_CLIENT_ID: "123"},
		}),
	);
	const r = await client.callTool({name: "grumble_servers", arguments: {}});
	assert.equal(r.isError, true);
	assert.match(r.content[0].text, /desktop app isn't running/);
	await client.close();
});
