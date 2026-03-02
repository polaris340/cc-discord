import { Client, GatewayIntentBits, Partials } from "discord.js";
import { spawn } from "child_process";
import { writeFile, mkdir, readdir, stat, open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const ALLOWED_USER_ID = process.env.ALLOWED_USER_ID;
const WORKSPACE = process.env.WORKSPACE || process.cwd();

const EDIT_INTERVAL = 1500;
const MAX_MSG_LENGTH = 1900;

// ── Discord client ──────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

client.once("ready", () => {
  console.log(`Bot ready: ${client.user.tag}`);
});

// ── Session management ──────────────────────────────────────────────
const sessions = new Map(); // channelId → session

function getOrCreateSession(channelId) {
  if (sessions.has(channelId)) return sessions.get(channelId);
  return spawnClaude(channelId);
}

function spawnClaude(channelId, model, resumeSessionId) {
  // Kill existing process if any
  const existing = sessions.get(channelId);
  if (existing) {
    existing.onDone = null;
    existing.onChunk = null;
    existing.proc.kill();
    sessions.delete(channelId);
  }

  const selectedModel = model || existing?.model || "sonnet";
  console.log(`[${channelId}] starting claude session (model: ${selectedModel}${resumeSessionId ? `, resume: ${resumeSessionId}` : ""})`);

  const args = [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--dangerously-skip-permissions",
    "--model", selectedModel,
  ];
  if (resumeSessionId) args.push("--resume", resumeSessionId);

  const proc = spawn("claude", args, { cwd: WORKSPACE });

  const session = {
    proc,
    channelId,
    model: selectedModel,
    sessionId: null,
    outputBuffer: "",
    outputPrefix: "",
    lastText: "",
    onChunk: null,
    onDone: null,
    busy: false,
    messageQueue: [],
  };

  // NDJSON line-buffered parser
  let lineBuf = "";
  proc.stdout.on("data", (data) => {
    lineBuf += data.toString();
    const lines = lineBuf.split("\n");
    lineBuf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        handleClaudeEvent(session, event);
      } catch {}
    }
  });

  proc.stderr.on("data", (data) => {
    console.error(`[claude stderr] ${data}`);
  });

  proc.on("error", (err) => {
    console.error(`[${channelId}] claude spawn failed:`, err.message);
    session.onDone?.("❌ Failed to start claude: " + err.message);
    if (sessions.get(channelId) === session) sessions.delete(channelId);
  });

  proc.on("exit", (code) => {
    console.log(`[${channelId}] claude exited (code ${code})`);
    const dropped = session.messageQueue.length;
    session.messageQueue = [];
    session.busy = false;
    if (session.onDone) {
      let msg = session.outputBuffer || `❌ claude exited (code ${code})`;
      if (dropped) msg += `\n(${dropped} queued message(s) dropped)`;
      session.onDone(msg);
    }
    if (sessions.get(channelId) === session) sessions.delete(channelId);
  });

  sessions.set(channelId, session);
  return session;
}

// ── Claude stream-json event handling ───────────────────────────────
function handleClaudeEvent(session, event) {
  if (event.type === "system" && event.subtype === "init") {
    session.sessionId = event.session_id;
    console.log(`[${session.channelId}] session: ${event.session_id}, model: ${event.model}`);
    return;
  }

  if (event.type === "assistant") {
    const content = event.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "text" && block.text) {
          // New turn: text doesn't continue from previous → freeze buffer as prefix
          if (session.lastText && !block.text.startsWith(session.lastText)) {
            session.outputPrefix = session.outputBuffer;
          } else if (!session.lastText && session.outputBuffer) {
            // First text after tool_use markers → save markers as prefix
            session.outputPrefix = session.outputBuffer;
          }
          session.outputBuffer = session.outputPrefix
            ? session.outputPrefix + "\n" + block.text
            : block.text;
          session.lastText = block.text;
        } else if (block.type === "tool_use") {
          session.outputBuffer += `\n\`[${block.name}]\` `;
        }
      }
      session.onChunk?.(session.outputBuffer);
    }
    return;
  }

  if (event.type === "result") {
    if (event.subtype === "success") {
      // Use result text if available, otherwise keep buffer
      if (event.result) {
        session.outputBuffer = session.outputPrefix
          ? session.outputPrefix + "\n" + event.result
          : event.result;
      }
      session.onDone?.(session.outputBuffer);
      session.outputBuffer = "";
      session.outputPrefix = "";
      session.lastText = "";
      session.onChunk = null;
      session.onDone = null;
    } else if (event.subtype === "error") {
      const errMsg = event.error || "Unknown error";
      session.outputBuffer += `\n❌ ${errMsg}`;
      session.onDone?.(session.outputBuffer);
      session.outputBuffer = "";
      session.outputPrefix = "";
      session.lastText = "";
      session.onChunk = null;
      session.onDone = null;
    }
    return;
  }
}

// ── Send prompt to claude via stdin ─────────────────────────────────
function sendPrompt(session, text) {
  const msg = {
    type: "user",
    message: { role: "user", content: text },
    session_id: session.sessionId || "default",
    parent_tool_use_id: null,
  };
  session.proc.stdin.write(JSON.stringify(msg) + "\n");
}

// ── Session listing ──────────────────────────────────────────────────
function getSessionDir() {
  const abs = resolve(WORKSPACE);
  const encoded = abs.replace(/\//g, "-");
  return join(homedir(), ".claude", "projects", encoded);
}

async function getFirstUserMessage(filepath) {
  let handle;
  try {
    handle = await open(filepath, "r");
    const buf = Buffer.alloc(50000);
    const { bytesRead } = await handle.read(buf, 0, 50000, 0);
    const text = buf.toString("utf-8", 0, bytesRead);
    for (const line of text.split("\n")) {
      try {
        const d = JSON.parse(line);
        if (d.type === "user") {
          let msg = d.message?.content || "";
          if (Array.isArray(msg)) {
            msg = msg.filter((b) => b.type === "text").map((b) => b.text).join(" ");
          }
          msg = msg.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, "").trim();
          if (msg.length > 10) return msg.slice(0, 60);
        }
      } catch {}
    }
  } catch {} finally {
    await handle?.close();
  }
  return "";
}

async function listSessions(limit = 10) {
  const dir = getSessionDir();
  let files;
  try { files = await readdir(dir); }
  catch { return []; }

  const jsonlFiles = files.filter((f) => f.endsWith(".jsonl"));
  const sessions = [];
  for (const file of jsonlFiles) {
    const fp = join(dir, file);
    try {
      const st = await stat(fp);
      const sid = file.replace(".jsonl", "");
      const firstMsg = await getFirstUserMessage(fp);
      sessions.push({ sid, mtime: st.mtimeMs, firstMsg });
    } catch {}
  }
  sessions.sort((a, b) => b.mtime - a.mtime);
  return sessions.slice(0, limit);
}

// ── Commands ────────────────────────────────────────────────────────
const COMMANDS = {
  new: {
    run: (s, _args, _msg, channelId) => {
      s.messageQueue = [];
      spawnClaude(channelId);
    },
    reply: "🔄 New session started.",
  },

  model: {
    async run(s, args, message, channelId) {
      if (!args) {
        await message.reply("Usage: `!model <name>` (sonnet, opus, haiku)");
        return;
      }
      const model = args.trim();
      spawnClaude(channelId, model);
      await message.reply(`🔄 Restarted with model: ${model}`);
    },
  },

  abort: {
    async run(s, _args, message, channelId) {
      s.messageQueue = [];
      s.busy = false;
      s.onDone = null;
      s.onChunk = null;
      s.proc.kill();
      sessions.delete(channelId);
      await message.reply("🛑 Aborted. Use `!resume 1` to continue the conversation.");
    },
  },

  sessions: {
    async run(_s, _args, message) {
      const list = await listSessions(10);
      if (!list.length) {
        await message.reply("No saved sessions found.");
        return;
      }
      const lines = ["**Recent Sessions:**"];
      for (let i = 0; i < list.length; i++) {
        const { sid, mtime, firstMsg } = list[i];
        const date = new Date(mtime).toLocaleString("en-US", {
          month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
        });
        const preview = firstMsg || "(no preview)";
        lines.push(`\`${i + 1}\` \`${sid.slice(0, 8)}\` ${date} — ${preview}`);
      }
      lines.push("", "Use `!resume <number>` to resume a session.");
      await message.reply(lines.join("\n"));
    },
  },

  resume: {
    async run(_s, args, message, channelId) {
      if (!args) {
        await message.reply("Usage: `!resume <number>` (see `!sessions` for list)");
        return;
      }
      const idx = parseInt(args.trim(), 10);
      let sessionId;
      if (!isNaN(idx) && idx >= 1) {
        const list = await listSessions(10);
        if (idx > list.length) {
          await message.reply(`Only ${list.length} sessions available. Use \`!sessions\` to see list.`);
          return;
        }
        sessionId = list[idx - 1].sid;
      } else {
        // treat as partial/full session ID
        const list = await listSessions(50);
        const match = list.find((s) => s.sid.startsWith(args.trim()));
        if (!match) {
          await message.reply("Session not found. Use `!sessions` to see available sessions.");
          return;
        }
        sessionId = match.sid;
      }
      spawnClaude(channelId, null, sessionId);
      await message.reply(`🔄 Resumed session \`${sessionId.slice(0, 8)}…\``);
    },
  },
};

async function handleHelp(message) {
  const lines = [
    "**Commands:**",
    "`!new` — start a new session (kill + respawn)",
    "`!model <name>` — restart with a different model (sonnet, opus, haiku)",
    "`!abort` — abort current task",
    "`!sessions` — list recent sessions",
    "`!resume <n>` — resume a previous session",
    "`!help` — this message",
    "",
    "Any other message is sent to Claude as a prompt.",
    "Messages sent while busy are queued automatically.",
  ];
  await message.reply(lines.join("\n"));
}

// ── File attachment handling ─────────────────────────────────────────
const UPLOAD_DIR = join(WORKSPACE, "uploads");

async function downloadAttachments(attachments) {
  if (!attachments.size) return [];
  await mkdir(UPLOAD_DIR, { recursive: true });
  const paths = [];
  for (const [, att] of attachments) {
    const dest = join(UPLOAD_DIR, att.name);
    const res = await fetch(att.url);
    const buf = Buffer.from(await res.arrayBuffer());
    await writeFile(dest, buf);
    paths.push(dest);
  }
  return paths;
}

// ── Stream display & queue helpers ──────────────────────────────────
function attachStreamDisplay(session, replyMessage) {
  session.busy = true;
  let editTimer = null;
  let latestContent = "";
  let lastEditContent = "";
  let editChain = Promise.resolve();
  const messages = [replyMessage];
  let frozenLen = 0; // chars committed to previous (frozen) messages

  const doUpdate = async (content, isDone) => {
    if (frozenLen > content.length) frozenLen = content.length;
    const suffix = isDone ? "\n\n✅" : "\n\n⏳";
    let tail = content.slice(frozenLen);

    // freeze current message and create new ones while tail exceeds limit
    while (tail.length + suffix.length > MAX_MSG_LENGTH) {
      let cut = tail.lastIndexOf("\n", MAX_MSG_LENGTH - suffix.length);
      if (cut <= 0) cut = MAX_MSG_LENGTH - suffix.length;
      const chunk = tail.slice(0, cut);

      try { await messages[messages.length - 1].edit(chunk); }
      catch (e) { console.error("edit failed:", e.message); break; }

      try {
        const newMsg = await messages[messages.length - 1].reply("⏳");
        messages.push(newMsg);
      } catch (e) { console.error("new message failed:", e.message); break; }

      tail = tail.slice(cut);
      frozenLen += chunk.length;
    }

    // edit last message with remaining tail
    try { await messages[messages.length - 1].edit(tail + suffix); }
    catch (e) { console.error("edit failed:", e.message); }
  };

  const scheduleEdit = (content) => {
    latestContent = content;
    if (editTimer) return;
    editTimer = setTimeout(() => {
      editTimer = null;
      if (latestContent === lastEditContent) return;
      lastEditContent = latestContent;
      const c = latestContent;
      editChain = editChain.then(() => doUpdate(c, false));
    }, EDIT_INTERVAL);
  };

  session.onChunk = (buf) => scheduleEdit(buf);

  session.onDone = (buf) => {
    if (editTimer) {
      clearTimeout(editTimer);
      editTimer = null;
    }
    const content = buf || "*(empty response)*";
    editChain = editChain.then(() => doUpdate(content, true))
      .then(() => processQueue(session))
      .catch((e) => {
        console.error(`[${session.channelId}] editChain error:`, e.message);
        session.busy = false;
      });
  };
}

async function processQueue(session) {
  if (!session.messageQueue.length) {
    session.busy = false;
    return;
  }
  const { prompt, discordMessage } = session.messageQueue.shift();
  let reply;
  try {
    reply = await discordMessage.reply("⏳ Thinking...");
  } catch (e) {
    console.error(`[${session.channelId}] failed to reply to queued message:`, e.message);
    return processQueue(session);
  }
  attachStreamDisplay(session, reply);
  sendPrompt(session, prompt);
}

// ── Discord message handler ─────────────────────────────────────────
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (ALLOWED_USER_ID && message.author.id !== ALLOWED_USER_ID) return;

  const text = message.content.trim();
  if (!text && !message.attachments.size) return;

  // ! command handling
  if (text.startsWith("!")) {
    const spaceIdx = text.indexOf(" ");
    const cmdName = (spaceIdx === -1 ? text.slice(1) : text.slice(1, spaceIdx)).toLowerCase();
    const args = spaceIdx === -1 ? "" : text.slice(spaceIdx + 1).trim();

    if (cmdName === "help") {
      await handleHelp(message);
      return;
    }

    const cmd = COMMANDS[cmdName];
    if (cmd) {
      const session = sessions.get(message.channelId);
      const needsSession = !["sessions", "resume"].includes(cmdName);
      if (needsSession && !session) {
        await message.reply("No active session. Send a message first.");
        return;
      }
      await cmd.run(session, args, message, message.channelId);
      if (cmd.reply) await message.reply(cmd.reply);
      return;
    }

    // Unknown command
    await message.reply(`Unknown command: \`!${cmdName}\`. Try \`!help\`.`);
    return;
  }

  // Download attachments
  const filePaths = await downloadAttachments(message.attachments);
  let prompt = text;
  if (filePaths.length) {
    const listing = filePaths.map((p) => `  ${p}`).join("\n");
    prompt = (prompt ? prompt + "\n\n" : "") + `(attached files)\n${listing}`;
  }

  const session = getOrCreateSession(message.channelId);

  // Queue if already processing
  if (session.busy) {
    session.messageQueue.push({ prompt, discordMessage: message });
    await message.reply(`📥 Queued (#${session.messageQueue.length}). Will process after current response.`);
    return;
  }

  const reply = await message.reply("⏳ Thinking...");
  attachStreamDisplay(session, reply);
  sendPrompt(session, prompt);
});

// ── Queue management via Discord message delete/edit ─────────────────
client.on("messageDelete", (message) => {
  for (const [, session] of sessions) {
    const idx = session.messageQueue.findIndex((q) => q.discordMessage.id === message.id);
    if (idx !== -1) {
      session.messageQueue.splice(idx, 1);
      console.log(`[${session.channelId}] removed queued message #${idx + 1}`);
    }
  }
});

client.on("messageUpdate", (_old, newMsg) => {
  if (!newMsg.content) return;
  for (const [, session] of sessions) {
    const entry = session.messageQueue.find((q) => q.discordMessage.id === newMsg.id);
    if (entry) {
      entry.prompt = newMsg.content.trim();
      console.log(`[${session.channelId}] updated queued message`);
    }
  }
});

// ── Start ───────────────────────────────────────────────────────────
client.login(DISCORD_TOKEN);
