// What a coding agent can do in Grumble through this tool: everything you let it do when Grumble asked you, as you.
// It never sends anything as you (Grumble's developer terms keep automating to bots): a message is drafted in the box
// for you to send.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {z} from "zod";

const KINDS = {0: "text", 1: "DM", 2: "voice", 3: "group DM", 4: "category", 5: "announcements", 13: "stage", 15: "forum", 16: "media"};
const text = (t) => ({content: [{type: "text", text: t}]});
const nameOf = (u) => (u ? (u.global_name && u.global_name !== u.username ? `${u.global_name} (@${u.username})` : `@${u.username}`) : "someone");
const when = (iso) => (iso ? new Date(iso).toISOString().replace("T", " ").slice(0, 16) : "");

/** A message as a line: when, who, what (and what's attached, each with its place for grumble_attachment). */
export function line(m) {
	const files = (m.attachments ?? []).map((a, i) => (a.filename ? `${a.filename} #${a.index ?? i}` : "")).filter(Boolean);
	const extra = files.length ? ` [attached: ${files.join(", ")}]` : "";
	const embeds = (m.embeds ?? []).length && !m.content ? " [a link or embed]" : "";
	return `[${when(m.timestamp)}] ${nameOf(m.author)}: ${m.content || ""}${extra}${embeds}`.trim();
}

const MOST = 10 * 1024 * 1024;
const STATUS = {online: "online", idle: "idle", dnd: "on do not disturb", invisible: "invisible"};
const WHERE = {draft: "only yours", hidden: "hidden", pending: "waiting for the safety team's look", listed: "shared in Discover", rejected: "turned down"};
const TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".txt": "text/plain", ".md": "text/markdown", ".pdf": "application/pdf", ".mp4": "video/mp4", ".mp3": "audio/mpeg", ".zip": "application/zip", ".json": "application/json"};
const typeOf = (p) => TYPES[path.extname(p).toLowerCase()] ?? "application/octet-stream";
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, "a colour as #rrggbb");
const notAllowed = (what) => `You didn't let this tool ${what}. Take it back in Grumble (Settings, Authorised apps) and allow it again to.`;

/** Each tool, on `server` (the MCP server), through `grumble` (the connection to the desktop app). */
export function registerTools(server, grumble) {
	// (a command Grumble's own, which an older Grumble doesn't know)
	const newer = (cmd, args, opts) =>
		grumble.ask(cmd, args, opts).catch((e) => {
			throw /Unknown command|Not supported/.test(e?.message ?? "") ? new Error("This needs a newer Grumble: update the app (it updates itself when it starts).") : e;
		});
	const tool = (name, description, inputSchema, run, readOnly = true) =>
		server.registerTool(name, {description, inputSchema, annotations: {readOnlyHint: readOnly, openWorldHint: false}}, async (args) => {
			try {
				return await run(args ?? {});
			} catch (e) {
				return {...text(e instanceof Error ? e.message : String(e)), isError: true};
			}
		});
	const id = z.string().regex(/^\d+$/, "a Grumble id (digits)");

	tool("grumble_whoami", "Who's signed in to Grumble on this computer, and what this tool may do there.", {}, async () => {
		await grumble.conn();
		const g = grumble.granted;
		return text(`Signed in as ${nameOf(g?.user)} (id ${g?.user?.id}). This tool may: ${(g?.scopes ?? []).join(", ")}.`);
	});

	tool("grumble_servers", "Your Grumble servers: their ids and names.", {}, async () => {
		const {guilds} = await grumble.ask("GET_GUILDS");
		return text(guilds.length ? guilds.map((g) => `${g.id}  ${g.name}`).join("\n") : "You're in no servers.");
	});

	tool(
		"grumble_channels",
		'A server\'s channels (ids, names, kinds), or your DMs and group DMs with server_id "@me".',
		{server_id: z.union([id, z.literal("@me")]).describe('A server id from grumble_servers, or "@me" for your DMs')},
		async ({server_id}) => {
			const {channels} = await grumble.ask("GET_CHANNELS", {guild_id: server_id});
			return text(channels.length ? channels.map((c) => `${c.id}  ${KINDS[c.type] ?? c.type}  ${c.name}`).join("\n") : "No channels.");
		},
	);

	tool(
		"grumble_read",
		"The latest messages in a channel or DM (up to 50), oldest first, encrypted ones opened as you see them. With before (a message id), the ones before it, to read further back.",
		{
			channel_id: id,
			limit: z.number().int().min(1).max(50).optional().describe("How many (30 if not said)"),
			before: id.optional().describe("Read the messages before this one (its id, shown in brackets in what this returns)"),
		},
		async ({channel_id, limit = 30, before}) => {
			if (!grumble.may("messages.read")) return text(notAllowed("read messages"));
			const c = await grumble.ask("GET_CHANNEL", {channel_id, ...(before ? {before} : {})}, {timeout: 60_000});
			const msgs = (c.messages ?? []).slice(-limit);
			const head = `${KINDS[c.type] ?? "channel"} ${c.name ? `#${c.name}` : ""} (${c.id})`;
			// (a forum holds posts: each one's title and id, to read as a channel of its own)
			if (Array.isArray(c.threads))
				return text(
					c.threads.length
						? `${head}, its posts, newest first (read one with grumble_read and its id):\n${c.threads.map((t) => `${t.id}  ${t.name}  ${t.message_count} ${t.message_count === 1 ? "reply" : "replies"}${t.archived ? "  (closed)" : ""}`).join("\n")}`
						: `${head}: no posts.`,
				);
			return text(msgs.length ? `${head}\n${msgs.map((m) => `${line(m)} (${m.id})`).join("\n")}` : `${head}: no ${before ? "earlier " : ""}messages.`);
		},
	);

	tool(
		"grumble_attachment",
		"A file attached to a message, as you'd see it in Grumble (an encrypted one opened on your computer): a picture comes back to look at, a text file as its words, anything else saved on this computer and its path given. index is its place among the message's files (grumble_read shows each as #0, #1...).",
		{
			channel_id: id,
			message_id: id,
			index: z.number().int().min(0).max(9).optional().describe("Which of the message's files, from 0 (0 if not said)"),
		},
		async ({channel_id, message_id, index = 0}) => {
			if (!grumble.may("messages.read")) return text(notAllowed("read messages"));
			const f = await newer("GET_ATTACHMENT", {channel_id, message_id, index}, {timeout: 120_000});
			const type = f.content_type ?? "application/octet-stream";
			const about = `${f.filename} (${type}, ${f.size < 1024 ? `${f.size} bytes` : `${Math.round(f.size / 1024)} KB`})`;
			// a picture, to look at (the kinds agents can see)
			if (/^image\/(png|jpeg|gif|webp)$/.test(type)) return {content: [{type: "text", text: about}, {type: "image", data: f.data, mimeType: type}]};
			// words, as words (the first hundred thousand characters)
			if (/^text\/|json|xml|javascript|csv|yaml|markdown/.test(type)) {
				const words = Buffer.from(f.data, "base64").toString("utf8");
				return text(`${about}:\n${words.slice(0, 100_000)}${words.length > 100_000 ? "\n(cut short)" : ""}`);
			}
			// anything else: on this computer, readable only by you
			const dir = path.join(os.tmpdir(), "grumble-mcp", message_id);
			await fs.mkdir(dir, {recursive: true, mode: 0o700});
			const at = path.join(dir, path.basename(f.filename || `file-${index}`));
			await fs.writeFile(at, Buffer.from(f.data, "base64"), {mode: 0o600});
			return text(`${about}, saved at ${at}`);
		},
	);

	tool("grumble_unread", "The conversations with messages you haven't read: mentions of you first, then the newest.", {}, async () => {
		const {channels} = await newer("GET_UNREAD");
		if (!channels.length) return text("Nothing unread.");
		return text(
			channels
				.map((c) => `${c.id}  ${c.guild_name ? `${c.guild_name} #${c.name}` : c.name}${c.mentions ? `  ${c.mentions} mention${c.mentions === 1 ? "" : "s"}` : ""}${c.muted ? "  (muted)" : ""}`)
				.join("\n"),
		);
	});

	tool(
		"grumble_search",
		'Searches messages in a server (all its channels, or one with channel_id) or a DM, 25 a page, newest first. Encrypted ones are searched on your computer by Grumble. The words can use Grumble\'s filters: from:name, has:image (link, file, video...), before:2026-11-01, after:, during:.',
		{
			query: z.string().min(1).describe("What to look for, with any filters"),
			server_id: id.optional().describe("A server to search"),
			channel_id: id.optional().describe("A channel in that server, or a DM, to search just that"),
			page: z.number().int().min(0).optional().describe("Which page of results, from 0"),
		},
		async ({query, server_id, channel_id, page = 0}) => {
			if (!grumble.may("messages.read")) return text(notAllowed("read messages"));
			const r = await newer("SEARCH_MESSAGES", {query, guild_id: server_id, channel_id, page}, {timeout: 60_000});
			if (!r.messages.length) return text("Nothing found.");
			return text(`${r.total} found (page ${page + 1} of ${Math.max(1, Math.ceil(r.total / 25))}):\n${r.messages.map((m) => `${m.channel_name ? `#${m.channel_name} ` : ""}${line(m)} (${m.id} in ${m.channel_id})`).join("\n")}`);
		},
	);

	tool(
		"grumble_draft",
		"Writes a message for you to send: opens the channel or DM in Grumble and puts the words (and any files) in its message box, after whatever's there. It's never sent until you send it yourself.",
		{
			channel_id: id,
			content: z.string().max(4000).optional().describe("The message's words"),
			files: z.array(z.string()).max(10).optional().describe("Paths of files on this computer to attach (10 MB at most in all)"),
		},
		async ({channel_id, content = "", files = []}) => {
			if (!grumble.may("messages.draft")) return text(notAllowed("draft messages"));
			const attached = [];
			let total = 0;
			for (const p of files) {
				const data = await fs.readFile(p);
				total += data.length;
				if (total > MOST) return text("Those files are too big together (10 MB at most).");
				attached.push({name: path.basename(p), type: typeOf(p), data: data.toString("base64")});
			}
			await newer("DRAFT_MESSAGE", {channel_id, content, files: attached}, {timeout: 60_000});
			return text(`It's in the message box in Grumble${attached.length ? `, with ${attached.length} file${attached.length === 1 ? "" : "s"}` : ""}, for you to send.`);
		},
		false,
	);

	tool("grumble_status", "Your status in Grumble (online, idle, do not disturb or invisible) and your custom status.", {}, async () => {
		const s = await newer("GET_STATUS");
		return text(`You're ${STATUS[s.status] ?? s.status}${s.custom_status?.text ? `, with "${s.custom_status.text}"` : ""}.`);
	});

	tool(
		"grumble_set_status",
		'Sets your status (online, idle, dnd for do not disturb, invisible) and your custom status (its words, or "" to clear it).',
		{
			status: z.enum(["online", "idle", "dnd", "invisible"]).optional(),
			custom_status: z.string().max(128).optional().describe('Your custom status\'s words, "" to clear it'),
			emoji: z.string().max(32).optional().describe("An emoji to go with it"),
		},
		async ({status, custom_status, emoji}) => {
			if (!grumble.may("rpc.status.write")) return text(notAllowed("set your status"));
			const s = await newer("SET_STATUS", {...(status ? {status} : {}), ...(custom_status === undefined ? {} : {custom_status, emoji})});
			return text(`You're ${STATUS[s.status] ?? s.status}${s.custom_status?.text ? `, with "${s.custom_status.text}"` : ""}.`);
		},
		false,
	);

	// ---- themes and cosmetics (grumble.gg/developers/cosmetics has each kind's prompt and the skill)

	const made = (c) => `Made "${c.name}" (${c.kind}, ${c.id}), saved as yours: only you see it. Use grumble_open_creation to show it in Grumble, where you can wear or use it, change it, and share it in Discover.`;
	tool(
		"grumble_make_theme",
		"Makes a colour theme, saved as yours (only you see it until you share it). Five colours, #rrggbb: background (the chat, the biggest area), panel (the column beside it), rail (the strip of server icons, usually darkest), text (readable on the background), accent (buttons and highlights). Grumble keeps the text readable whatever you pick.",
		{
			name: z.string().min(2).max(40),
			description: z.string().max(300).optional(),
			colors: z.object({accent: hex, background: hex, panel: hex, rail: hex, text: hex}),
		},
		async ({name, description = "", colors}) => {
			if (!grumble.may("creations.write")) return text(notAllowed("make themes and cosmetics"));
			return text(made(await newer("CREATE_CREATION", {kind: "theme", name, description, colors})));
		},
		false,
	);

	tool(
		"grumble_make_filter",
		"Makes a camera filter for calls, saved as yours. Settings from -1 to 1 (0 changes nothing): exposure, contrast, saturation, warmth (+ warmer), tint (+ magenta); from 0 to 1: fade, vignette, tone (how much shadows and highlights are tinted); shadows and highlights are #rrggbb. Small changes go a long way: faces should look natural.",
		{
			name: z.string().min(2).max(40),
			description: z.string().max(300).optional(),
			settings: z.object({
				exposure: z.number().min(-1).max(1).optional(),
				contrast: z.number().min(-1).max(1).optional(),
				saturation: z.number().min(-1).max(1).optional(),
				warmth: z.number().min(-1).max(1).optional(),
				tint: z.number().min(-1).max(1).optional(),
				fade: z.number().min(0).max(1).optional(),
				vignette: z.number().min(0).max(1).optional(),
				tone: z.number().min(0).max(1).optional(),
				shadows: hex.optional(),
				highlights: hex.optional(),
			}),
		},
		async ({name, description = "", settings}) => {
			if (!grumble.may("creations.write")) return text(notAllowed("make themes and cosmetics"));
			return text(made(await newer("CREATE_CREATION", {kind: "filter", name, description, settings})));
		},
		false,
	);

	tool(
		"grumble_make_cosmetic",
		"Makes a cosmetic from a picture on this computer (PNG, JPEG, GIF or WebP, 10 MB at most), saved as yours. Grumble cuts it to the kind's shape around its middle and scales it: decoration 320x320 (drawn around the avatar, whose circle is the middle 83% across: keep that see-through), nameplate 600x150 (behind a name, which sits over the left half), effect 450x600 (over the whole profile card, mostly see-through, detail at the edges), icon a 1024 square (the app's icon; corners are rounded off), backdrop 1920x1080 (behind you in calls; you cover the middle and bottom). For a decoration or effect, a flat pure green (#00FF00) background is cut out; real transparency is better if you can make it. Moving GIFs and WebPs are kept as they are.",
		{
			kind: z.enum(["decoration", "nameplate", "effect", "icon", "backdrop"]),
			name: z.string().min(2).max(40),
			description: z.string().max(300).optional(),
			file: z.string().describe("The picture's path on this computer"),
		},
		async ({kind, name, description = "", file}) => {
			if (!grumble.may("creations.write")) return text(notAllowed("make themes and cosmetics"));
			const type = typeOf(file);
			if (!/^image\/(png|jpeg|gif|webp)$/.test(type)) return text("The picture has to be a PNG, JPEG, GIF or WebP.");
			const data = await fs.readFile(file);
			if (data.length > MOST) return text("That picture is too big (10 MB at most).");
			const image = `data:${type};base64,${data.toString("base64")}`;
			return text(made(await newer("CREATE_CREATION", {kind, name, description, image}, {timeout: 120_000})));
		},
		false,
	);

	tool("grumble_my_creations", "Your themes, filters and cosmetics: their ids, kinds, names and where each is at (draft, waiting for the safety team's look, shared, turned down).", {}, async () => {
		if (!grumble.may("creations.write")) return text(notAllowed("make themes and cosmetics"));
		const {creations} = await newer("GET_CREATIONS");
		if (!creations.length) return text("You haven't made any yet.");
		return text(creations.map((c) => `${c.id}  ${c.kind}  ${c.name}  (${WHERE[c.status] ?? c.status}${c.taken_out ? ", taken out by the safety team" : ""}${c.review_note ? `: ${c.review_note}` : ""})`).join("\n"));
	});

	tool(
		"grumble_open_creation",
		"Shows one of your themes, filters or cosmetics in Grumble's window, where you can use or wear it, change it, and share it in Discover.",
		{id},
		async ({id}) => {
			if (!grumble.may("creations.write")) return text(notAllowed("make themes and cosmetics"));
			const c = await newer("OPEN_CREATION", {id});
			return text(`Showing "${c.name}" in Grumble.`);
		},
		false,
	);

	tool("grumble_open", "Shows a channel or DM in Grumble's window.", {channel_id: id}, async ({channel_id}) => {
		await grumble.ask("SELECT_TEXT_CHANNEL", {channel_id});
		return text("Opened in Grumble.");
	}, false);

	tool(
		"grumble_watch",
		"Starts (or with stop, stops) keeping new messages in a channel or DM, for grumble_new_messages.",
		{channel_id: id, stop: z.boolean().optional()},
		async ({channel_id, stop}) => {
			await grumble.watch(channel_id, !stop);
			return text(stop ? "Stopped watching." : "Watching: new messages are kept for grumble_new_messages.");
		},
	);

	tool("grumble_new_messages", "New messages in the channels being watched since this was last asked (and forgets them).", {}, async () => {
		await grumble.conn();
		const got = grumble.messages.splice(0);
		return text(got.length ? got.map((m) => `(${m.channel_id}) ${line(m.message)}`).join("\n") : `Nothing new${grumble.watched.size ? "" : " (nothing's being watched: use grumble_watch)"}.`);
	});

	tool("grumble_notifications", "Grumble's notifications since this was last asked (and forgets them).", {}, async () => {
		await grumble.conn();
		if (!grumble.may("rpc.notifications.read")) return text("You didn't let this tool see notifications.");
		const got = grumble.notifications.splice(0);
		return text(got.length ? got.map((n) => `[${when(n.at)}] ${n.title}: ${n.body}`).join("\n") : "No notifications.");
	});

	tool("grumble_voice", "Which voice channel you're in, if any, who's there, and whether you're muted or deafened.", {}, async () => {
		const [where, settings] = await Promise.all([grumble.ask("GET_SELECTED_VOICE_CHANNEL"), grumble.may("rpc.voice.read") ? grumble.ask("GET_VOICE_SETTINGS") : null]);
		const people = (where?.voice_states ?? []).map((v) => v.nick ?? nameOf(v.user)).join(", ");
		const you = settings ? ` You're ${settings.mute ? "muted" : "not muted"}${settings.deaf ? " and deafened" : ""}.` : "";
		return text(where ? `In ${where.name} (${where.id})${people ? ` with ${people}` : ""}.${you}` : `Not in a voice channel.${you}`);
	});

	tool("grumble_join_voice", "Joins a voice channel (you, in Grumble).", {channel_id: id}, async ({channel_id}) => {
		await grumble.ask("SELECT_VOICE_CHANNEL", {channel_id, force: true});
		return text("Joined.");
	}, false);

	tool("grumble_leave_voice", "Leaves the voice channel you're in.", {}, async () => {
		await grumble.ask("SELECT_VOICE_CHANNEL", {channel_id: null});
		return text("Left voice.");
	}, false);

	tool(
		"grumble_set_voice",
		"Mutes or unmutes you, and deafens or undeafens you.",
		{mute: z.boolean().optional(), deaf: z.boolean().optional()},
		async ({mute, deaf}) => {
			const s = await grumble.ask("SET_VOICE_SETTINGS", {...(mute === undefined ? {} : {mute}), ...(deaf === undefined ? {} : {deaf})});
			return text(`You're ${s?.mute ? "muted" : "not muted"}${s?.deaf ? " and deafened" : ""}.`);
		},
		false,
	);
}
