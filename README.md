# grumble-mcp

Use [Grumble](https://grumble.gg) from your coding agent. Claude Code, Cursor, VS Code, Codex or any other agent that
speaks MCP can read your servers, channels, DMs and messages, search them, see what's unread, keep an eye on channels,
see your notifications, join voice or mute you, set your status, write messages for you to send, and make themes and
cosmetics for you, through the Grumble desktop app on your computer.

It only talks to the Grumble app on the same computer. The first time it's used, Grumble asks you in its window what
it may do. You can take that back any time in Grumble's Settings, Authorised apps.

It never sends anything as you. A message it writes goes in the conversation's message box in Grumble, and it's sent
only when you send it. What it makes is saved as yours, seen only by you until you share it in Discover yourself.

## Set it up

You need the Grumble desktop app open and signed in, and Node.js 18 or later.

**Claude Code**

```sh
claude mcp add grumble -- npx -y grumble-mcp
```

**Cursor, VS Code, Codex and others**: add an MCP server that runs `npx -y grumble-mcp`. In an `mcp.json`:

```json
{"mcpServers": {"grumble": {"command": "npx", "args": ["-y", "grumble-mcp"]}}}
```

Then ask your agent something like "what's new in #general on Grumble?". The first time, look at Grumble's window and
press Allow.

## Tools

| Tool | What it does |
|---|---|
| `grumble_whoami` | Who's signed in, and what this tool may do |
| `grumble_servers` | Your servers |
| `grumble_channels` | A server's channels, or your DMs with `"@me"` |
| `grumble_read` | The latest messages in a channel or DM (encrypted ones opened as you see them), or with `before`, further back |
| `grumble_open` | Shows a channel or DM in Grumble |
| `grumble_watch` | Starts or stops keeping new messages in a channel |
| `grumble_new_messages` | New messages in watched channels since last asked |
| `grumble_notifications` | Grumble's notifications since last asked |
| `grumble_voice` | Which voice channel you're in, who's there, muted or not |
| `grumble_join_voice` / `grumble_leave_voice` | Joins or leaves a voice channel |
| `grumble_set_voice` | Mutes or deafens you |
| `grumble_unread` | Conversations with messages you haven't read, mentions of you first |
| `grumble_search` | Searches a server's or a DM's messages (encrypted ones searched on your computer) |
| `grumble_draft` | Writes a message (and attaches files) in a conversation's message box, for you to send |
| `grumble_status` / `grumble_set_status` | Your status and custom status |
| `grumble_make_theme` | Makes a colour theme from five colours |
| `grumble_make_filter` | Makes a camera filter for calls |
| `grumble_make_cosmetic` | Makes an avatar decoration, nameplate, profile effect, app icon or camera background from a picture, fitted as it's worn |
| `grumble_my_creations` | Your themes, filters and cosmetics, and where each is at |
| `grumble_open_creation` | Shows one of yours in Grumble, to use it, change it or share it |

Making cosmetics? [grumble.gg/developers/cosmetics](https://grumble.gg/developers/cosmetics/) has each kind's size and
a prompt for it, and a skill that teaches your agent all of it.

## How it signs in

It connects to the Grumble app over the same local connection Discord's apps use, and asks you there. When you say
yes, it signs in with PKCE, without a client secret. Its token is kept on your computer, readable only by you, in
`~/.config/grumble-mcp` (`%APPDATA%\grumble-mcp` on Windows). Delete that folder to sign it out here too.

If you set it up before it could write drafts, set your status or make things, Grumble asks you once about those.
Say no and it carries on as it was.

## Settings

- `GRUMBLE_SERVER`: a Grumble server other than `https://chat.grumble.gg`.
- `GRUMBLE_CLIENT_ID`: your own application to sign in as (a public client: Developer Portal, OAuth2).

More in the [developer docs](https://grumble.gg/developers/docs/#coding-agents).
