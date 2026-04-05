# pi-discord

Discord bridge for Pi with a `/discord` toggle command and Discord `/stop` + `/delete` slash commands.

## What it does

- Adds `/discord` command in Pi (toggle bridge on/off)
- Registers Discord slash commands (keeps only `/stop` and `/delete`)
- When ON, starts a background Discord bridge service
- Uses a PID owner lock (`contexts/discord-owner.lock.json`) so only the currently-enabled Pi instance can send/receive Discord events
- If the lock PID no longer matches, the bridge self-shuts down to prevent duplicate responders
- Loads config from `pi-discord/.env` only
- Watches one Discord channel for one specific user
- Creates a new Discord thread per new top-level message in that channel
- Maps each Discord thread to one Pi session
- Forwards every thread reply (including slash-prefixed text) to Pi
- `/stop` in a Pi thread aborts the active Pi run immediately (ESC-style)
- `/delete` in a Pi thread deletes that thread and its starter message in the parent channel
- Streams Pi output back to Discord in real-time
- Streams tool activity in separate updating messages
- Supports inbound image attachments to Pi
- Supports outbound file attachments from Pi via marker lines

## Required `.env`

Fill in:

```env
DISCORD_BOT_TOKEN=
DISCORD_GUILD_ID=
DISCORD_CHANNEL_ID=
DISCORD_USER_ID=
```

## Install

From `pi-discord/`:

```bash
npm install
```

Use the package entry in `~/.pi/agent/settings.json` as the single source of truth (no extension symlink).

If you previously symlinked this extension, remove it:

```bash
rm -f "$HOME/.pi/agent/extensions/discord-mode.ts"
```

Reload Pi extensions:

```text
/reload
```

## Usage

In Pi:

```text
/discord
```

Run again to disable.

In Discord (inside a Pi thread):

```text
/stop
```

This aborts the active Pi run immediately.

```text
/delete
```

This deletes the current Pi thread and the parent-channel message that created it.

## Slash command sync / cleanup

To clear old global commands and set this guild to only `/stop` + `/delete`:

```bash
npm run sync-commands
```

## Outbound file attachments from Pi

If Pi should attach files to Discord, it can emit lines like:

```text
DISCORD_ATTACH: /absolute/path/to/file.ext
```

The bridge uploads those files to the Discord thread.
