# cc-discord

Discord bot that bridges to [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI. Each channel maintains a persistent `claude` process using the stream-json protocol, enabling multi-turn conversations with streamed responses.

## Architecture

```
Discord message → bot.js → queue (if busy) → claude process (1 per channel)
                                                ↕ stdin/stdout (NDJSON)
                                             stream-json bidirectional
                                                ↓
                                          throttled message edits → Discord
```

## Setup

```bash
cp .env.example .env
# Edit .env with your DISCORD_TOKEN, ALLOWED_USER_ID, WORKSPACE
bun install
bun bot.js
```

### Docker

```bash
# First run: authenticate claude CLI
docker compose run --rm cc-discord claude

# Run the bot
docker compose up -d
```

## Virtual Display (noVNC)

The container runs a virtual display (Xvfb) so Claude Code can use browser and computer-use tools. View the display in your browser:

```
http://localhost:6080/vnc.html
```

To change the host port, set `NOVNC_HOST_PORT` in `.env`.

## Commands

| Command | Description |
|---------|-------------|
| `!new` | Start a new session (kill + respawn) |
| `!model <name>` | Restart with a different model (sonnet, opus, haiku) |
| `!abort` | Abort current task (session preserved) |
| `!sessions` | List recent sessions with previews |
| `!resume <n>` | Resume a previous session by number or ID |
| `!help` | Show command list |

Any other message is sent to Claude as a prompt. Messages sent while Claude is busy are automatically queued and processed in order.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DISCORD_TOKEN` | Yes | Discord bot token |
| `ALLOWED_USER_ID` | No | Restrict bot to a single Discord user |
| `WORKSPACE` | No | Working directory for claude processes (default: cwd) |
| `NOVNC_HOST_PORT` | No | noVNC host port (default: 6080) |
| `SCREEN_RESOLUTION` | No | Virtual display resolution (default: 1920x1080x24) |
