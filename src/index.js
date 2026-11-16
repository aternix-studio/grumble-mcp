#!/usr/bin/env node
// grumble-mcp: lets a coding agent (Claude Code, Cursor, VS Code, Codex and any other that speaks MCP) use Grumble on
// this computer, as you, for what you allow when Grumble asks: read your servers, channels and messages (encrypted
// ones too, opened by Grumble's app), keep an eye on channels, see notifications, and join voice or mute you. It talks
// only to Grumble's desktop app on this computer, and signs in once.
//   claude mcp add grumble -- npx -y grumble-mcp
// GRUMBLE_SERVER: a Grumble server other than chat.grumble.gg; GRUMBLE_CLIENT_ID: your own application (a public
// client, Developer Portal, OAuth2) to sign in as instead of Grumble's own.
import {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";
import {StdioServerTransport} from "@modelcontextprotocol/sdk/server/stdio.js";
import {createRequire} from "node:module";
import {Grumble} from "./grumble.js";
import {registerTools} from "./tools.js";

/** Grumble's own application for coding agents, on chat.grumble.gg (a public client). */
export const CLIENT_ID = "1569931651234922496";

const {version} = createRequire(import.meta.url)("../package.json");
const grumble = new Grumble({clientId: process.env.GRUMBLE_CLIENT_ID || CLIENT_ID, server: process.env.GRUMBLE_SERVER || "https://chat.grumble.gg"});
const server = new McpServer(
	{name: "grumble", version},
	{
		instructions:
			"Grumble is a chat app. These tools use the Grumble desktop app on this computer as its user, for what they allowed. Find ids with grumble_servers and grumble_channels (\"@me\" for DMs), read with grumble_read. The first tool used asks the user to allow it in Grumble's window: tell them to look there.",
	},
);
registerTools(server, grumble);
await server.connect(new StdioServerTransport());
const bye = () => (grumble.close(), process.exit(0));
process.on("SIGINT", bye);
process.on("SIGTERM", bye);
