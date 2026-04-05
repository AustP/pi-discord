#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
	AttachmentBuilder,
	ChannelType,
	Client,
	GatewayIntentBits,
	Partials,
	SlashCommandBuilder,
} from "discord.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIR, "..");
const ENV_PATH = resolve(PROJECT_ROOT, ".env");
const CONTEXT_DIR = resolve(PROJECT_ROOT, "contexts");
const INCOMING_DIR = resolve(CONTEXT_DIR, "incoming");
const PI_COMMAND = "pi";
const PI_ARGS = ["--mode", "rpc"];
const MAX_MESSAGE_CHARS = 1900;
const TOOL_UPDATE_DEBOUNCE_MS = 450;
const TEXT_UPDATE_DEBOUNCE_MS = 300;
const MAX_OUTBOUND_FILES = 5;
const MAX_OUTBOUND_FILE_BYTES = 8 * 1024 * 1024;
const FILE_MARKER = "DISCORD_ATTACH:";
const DISCORD_PI_PWD = String(process.env.DISCORD_PI_PWD || "").trim();
const DISCORD_PI_PID = parsePositiveInt(process.env.DISCORD_PI_PID);
const OWNER_LOCK_PATH = resolve(PROJECT_ROOT, "contexts", "discord-owner.lock.json");
const STOP_COMMAND_NAME = "stop";
const DELETE_COMMAND_NAME = "delete";
const APPEND_SYSTEM_PROMPT = [
	"Discord attachment return protocol:",
	`- If you want to attach a file back to Discord, output one line exactly as: ${FILE_MARKER} /absolute/path/to/file`,
	"- Use absolute paths only.",
	"- Only emit markers for files that already exist and are ready to upload.",
].join("\n");

const requiredEnv = loadEnv(ENV_PATH, [
	"DISCORD_BOT_TOKEN",
	"DISCORD_GUILD_ID",
	"DISCORD_CHANNEL_ID",
	"DISCORD_USER_ID",
]);

if (!requiredEnv.ok) {
	console.log(`ERROR:${requiredEnv.error}`);
	process.exit(1);
}

const {
	DISCORD_BOT_TOKEN,
	DISCORD_GUILD_ID,
	DISCORD_CHANNEL_ID,
	DISCORD_USER_ID,
} = requiredEnv.values;

await mkdir(CONTEXT_DIR, { recursive: true });
await mkdir(INCOMING_DIR, { recursive: true });

if (!DISCORD_PI_PID) {
	console.log("ERROR:Missing DISCORD_PI_PID in environment");
	process.exit(1);
}

try {
	await writeOwnerLock();
} catch (error) {
	console.log(`ERROR:Failed to write owner lock: ${formatError(error)}`);
	process.exit(1);
}

const runtimeByThreadId = new Map();
let shuttingDown = false;

const client = new Client({
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.MessageContent,
	],
	partials: [Partials.Channel],
});

client.once("ready", async () => {
	try {
		await syncSlashCommands();
		await updateConfiguredChannelDescription();
		console.log("READY");
	} catch (error) {
		console.log(`ERROR:${formatError(error)}`);
		process.exit(1);
	}
});

client.on("messageCreate", async (message) => {
	if (shuttingDown) return;
	if (message.author?.bot) return;
	if (!message.guildId || message.guildId !== DISCORD_GUILD_ID) return;
	if (message.author.id !== DISCORD_USER_ID) return;
	if (!(await ensureOwnershipOrShutdown("messageCreate"))) return;

	if (message.channel.isThread()) {
		if (message.channel.parentId !== DISCORD_CHANNEL_ID) return;
		await forwardMessageToPi(message, message.channel);
		return;
	}

	if (message.channelId !== DISCORD_CHANNEL_ID) return;
	if (message.channel.type !== ChannelType.GuildText) return;

	try {
		const thread = await message.startThread({
			name: buildThreadName(message.content || "pi session"),
			autoArchiveDuration: 1440,
			reason: "Pi Discord bridge",
		});
		await forwardMessageToPi(message, thread);
	} catch (error) {
		console.error("Failed to create thread:", error);
		await safeReply(message, `Failed to create thread: ${formatError(error)}`);
	}
});

client.on("interactionCreate", async (interaction) => {
	if (!interaction.isChatInputCommand()) return;
	if (interaction.guildId !== DISCORD_GUILD_ID) {
		await safeInteractionReply(interaction, { content: "This command is not available here.", ephemeral: true });
		return;
	}
	if (interaction.user.id !== DISCORD_USER_ID) {
		await safeInteractionReply(interaction, { content: "You are not allowed to use this command.", ephemeral: true });
		return;
	}
	if (!(await ensureOwnershipOrShutdown("interactionCreate"))) return;
	if (!interaction.channel?.isThread() || interaction.channel.parentId !== DISCORD_CHANNEL_ID) {
		await safeInteractionReply(interaction, { content: "Use this command inside a Pi thread.", ephemeral: true });
		return;
	}

	if (interaction.commandName === STOP_COMMAND_NAME) {
		const runtime = runtimeByThreadId.get(interaction.channel.id);
		if (!runtime) {
			await safeInteractionReply(interaction, { content: "No Pi session is active in this thread.", ephemeral: true });
			return;
		}
		try {
			const stopped = await runtime.abortActiveRun();
			await safeInteractionReply(interaction, {
				content: stopped ? "Stopped the active Pi run." : "No active Pi run to stop.",
				ephemeral: true,
			});
			if (stopped) {
				await sendDiscordMessage(interaction.channel, "⏹️ Stopped current Pi run.", "interaction-stop");
			}
		} catch (error) {
			await safeInteractionReply(interaction, { content: `Failed to stop: ${formatError(error)}`, ephemeral: true });
		}
		return;
	}

	if (interaction.commandName === DELETE_COMMAND_NAME) {
		await interaction.deferReply({ ephemeral: true });
		const thread = interaction.channel;
		await stopRuntime(thread.id);

		let starterDeleted = false;
		let threadDeleted = false;
		const issues = [];

		const starterMessage = await getStarterMessage(thread);
		if (!starterMessage) {
			issues.push("Could not find the parent-channel starter message.");
		} else {
			try {
				await starterMessage.delete();
				starterDeleted = true;
			} catch (error) {
				issues.push(`Could not delete starter message: ${formatError(error)}`);
			}
		}

		try {
			await thread.delete("Requested via /delete");
			threadDeleted = true;
		} catch (error) {
			issues.push(`Could not delete thread: ${formatError(error)}`);
		}

		const summary = [
			starterDeleted ? "✅ Deleted starter message." : "⚠️ Starter message not deleted.",
			threadDeleted ? "✅ Deleted thread." : "⚠️ Thread not deleted.",
			...issues.map((issue) => `- ${issue}`),
		].join("\n");

		if (threadDeleted) {
			if (issues.length > 0) {
				console.warn(`[thread:${thread.id}] /delete completed with issues: ${issues.join(" | ")}`);
			}
			return;
		}

		await safeInteractionEditReply(interaction, summary);
	}
});

client.on("threadDelete", async (thread) => {
	await stopRuntime(thread.id);
});

client.on("threadUpdate", async (_oldThread, newThread) => {
	if (!newThread.isThread()) return;
	if (newThread.parentId !== DISCORD_CHANNEL_ID) return;
	if (!newThread.archived && !newThread.locked) return;
	await stopRuntime(newThread.id);
});

client.on("error", (error) => {
	console.error("Discord client error:", error);
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await client.login(DISCORD_BOT_TOKEN);

async function syncSlashCommands() {
	if (!client.application) throw new Error("Discord application is not ready.");
	const stopCommand = new SlashCommandBuilder()
		.setName(STOP_COMMAND_NAME)
		.setDescription("Stop the active Pi response in this thread immediately");
	const deleteCommand = new SlashCommandBuilder()
		.setName(DELETE_COMMAND_NAME)
		.setDescription("Delete this Pi thread and its parent starter message");
	await client.application.commands.set([]);
	const guild = await client.guilds.fetch(DISCORD_GUILD_ID);
	await guild.commands.set([stopCommand.toJSON(), deleteCommand.toJSON()]);
}

async function updateConfiguredChannelDescription() {
	if (!DISCORD_PI_PWD) return;
	const topic = truncate(`Pi pwd: ${DISCORD_PI_PWD}`, 1024);
	try {
		const channel = await client.channels.fetch(DISCORD_CHANNEL_ID);
		if (!channel || typeof channel.setTopic !== "function") return;
		if (channel.topic === topic) return;
		await channel.setTopic(topic, "Pi Discord bridge enabled");
	} catch (error) {
		console.warn(`Failed to update channel description: ${formatError(error)}`);
	}
}

async function writeOwnerLock() {
	const payload = {
		piPid: DISCORD_PI_PID,
		bridgePid: process.pid,
		updatedAt: new Date().toISOString(),
	};
	await writeFile(OWNER_LOCK_PATH, `${JSON.stringify(payload, null, 2)}\n`);
}

function readOwnerLockPid() {
	try {
		const raw = readFileSync(OWNER_LOCK_PATH, "utf8");
		const parsed = JSON.parse(raw);
		return parsePositiveInt(parsed?.piPid);
	} catch {
		return null;
	}
}

async function ensureOwnershipOrShutdown(source) {
	const ownerPid = readOwnerLockPid();
	if (!ownerPid || ownerPid === DISCORD_PI_PID) return true;
	console.warn(
		`[owner] lock mismatch on ${source}; lock has piPid=${ownerPid}, local piPid=${DISCORD_PI_PID}. Shutting down bridge.`,
	);
	await shutdown();
	return false;
}

async function forwardMessageToPi(message, thread) {
	const payload = await buildInboundPayload(message, thread.id);
	if (!payload) return;

	const runtime = await getOrCreateRuntime(thread.id);
	try {
		await runtime.enqueue(payload, thread);
	} catch (error) {
		console.error(`[thread:${thread.id}] forward failed`, error);
		await sendDiscordMessage(thread, `Error: ${formatError(error)}`, "forward-error");
	}
}

async function getOrCreateRuntime(threadId) {
	const existing = runtimeByThreadId.get(threadId);
	if (existing) return existing;
	const runtime = new PiThreadRuntime(threadId);
	runtimeByThreadId.set(threadId, runtime);
	await runtime.ensureStarted();
	return runtime;
}

async function stopRuntime(threadId) {
	const runtime = runtimeByThreadId.get(threadId);
	if (!runtime) return;
	runtimeByThreadId.delete(threadId);
	await runtime.stop();
}

async function shutdown() {
	if (shuttingDown) return;
	shuttingDown = true;
	const stops = Array.from(runtimeByThreadId.values(), (runtime) => runtime.stop());
	await Promise.allSettled(stops);
	runtimeByThreadId.clear();
	try {
		client.destroy();
	} catch {}
	process.exit(0);
}

class PiThreadRuntime {
	constructor(threadId) {
		this.threadId = threadId;
		this.sessionFile = null;
		this.proc = null;
		this.stdin = null;
		this.stdoutBuffer = "";
		this.pendingById = new Map();
		this.queue = Promise.resolve();
		this.activeRun = null;
		this.lastKnownState = null;
		this.sessionUsageTotals = createUsageTotals();
		this.contextUsageEstimate = createUsageTotals();
	}

	async ensureStarted() {
		if (this.proc && this.stdin) return;
		const args = [...PI_ARGS, "--append-system-prompt", APPEND_SYSTEM_PROMPT];
		if (this.sessionFile) args.push("--session", this.sessionFile);
		this.proc = spawn(PI_COMMAND, args, { stdio: ["pipe", "pipe", "pipe"] });
		this.stdin = this.proc.stdin;

		this.proc.on("exit", (code, signal) => {
			const error = new Error(`pi rpc exited (${code ?? signal ?? "unknown"})`);
			for (const pending of this.pendingById.values()) pending.reject(error);
			this.pendingById.clear();
			if (this.activeRun) {
				this.activeRun.reject(error);
				this.activeRun = null;
			}
			this.proc = null;
			this.stdin = null;
			this.stdoutBuffer = "";
		});

		this.proc.stderr.setEncoding("utf8");
		this.proc.stderr.on("data", (chunk) => {
			const text = String(chunk || "").trim();
			if (text) console.error(`[pi:${this.threadId}] ${text}`);
		});

		this.proc.stdout.setEncoding("utf8");
		this.proc.stdout.on("data", (chunk) => this.onStdoutChunk(String(chunk || "")));

		const state = await this.sendRpc({ type: "get_state" });
		this.lastKnownState = state || null;
		if (state && typeof state.sessionFile === "string" && state.sessionFile.trim()) {
			this.sessionFile = state.sessionFile;
		}
	}

	onStdoutChunk(chunk) {
		this.stdoutBuffer += chunk;
		while (true) {
			const newline = this.stdoutBuffer.indexOf("\n");
			if (newline === -1) break;
			const line = this.stdoutBuffer.slice(0, newline).replace(/\r$/, "").trim();
			this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
			if (!line) continue;
			let parsed;
			try {
				parsed = JSON.parse(line);
			} catch {
				continue;
			}
			this.onRpcMessage(parsed);
		}
	}

	onRpcMessage(message) {
		if (message?.type === "response") {
			const pending = this.pendingById.get(message.id);
			if (!pending) return;
			this.pendingById.delete(message.id);
			if (message.success) pending.resolve(message.data || {});
			else pending.reject(new Error(message.error || "RPC command failed"));
			return;
		}

		if (message?.type === "compaction_end") {
			this.contextUsageEstimate = createUsageTotals();
		}

		const run = this.activeRun;
		if (!run) return;
		run.publisher.onEvent(message).catch(() => undefined);

		if (message.type === "message_update") {
			const delta = message.assistantMessageEvent;
			if (delta?.type === "text_delta" && typeof delta.delta === "string") {
				run.text += delta.delta;
				run.publisher.onText(run.text).catch(() => undefined);
			}
			return;
		}

		if (message.type === "agent_end") {
			const assistantMessage = extractFinalAssistantMessage(message);
			if (assistantMessage?.usage) {
				this.sessionUsageTotals = mergeUsageTotals(this.sessionUsageTotals, assistantMessage.usage);
				this.contextUsageEstimate = normalizeUsage(assistantMessage.usage);
			}
			run.resolve();
			return;
		}

		if (message.type === "extension_error") {
			run.reject(new Error(String(message.error || "Extension error")));
		}
	}

	async sendRpc(command) {
		await this.ensureStarted();
		const id = randomUUID();
		const payload = { id, ...command };
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pendingById.delete(id);
				reject(new Error(`RPC timeout for ${command.type}`));
			}, 60_000);
			this.pendingById.set(id, {
				resolve: (value) => {
					clearTimeout(timeout);
					resolve(value);
				},
				reject: (error) => {
					clearTimeout(timeout);
					reject(error);
				},
			});
			this.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
				if (!error) return;
				clearTimeout(timeout);
				this.pendingById.delete(id);
				reject(error);
			});
		});
	}

	async enqueue(payload, thread) {
		const task = this.queue.then(() => this.runPayload(payload, thread));
		this.queue = task.catch(() => undefined);
		return task;
	}

	async abortActiveRun() {
		if (!this.proc || !this.stdin || !this.activeRun) return false;
		await this.sendRpc({ type: "abort" });
		return true;
	}

	async runPayload(payload, thread) {
		await this.ensureStarted();
		const publisher = new DiscordRunPublisher(thread);
		await publisher.start();

		try {
			let resolved = false;
			await new Promise((resolve, reject) => {
				this.activeRun = {
					text: "",
					publisher,
					resolve: () => {
						if (resolved) return;
						resolved = true;
						resolve();
					},
					reject: (error) => {
						if (resolved) return;
						resolved = true;
						reject(error);
					},
				};

				this.sendRpc({
					type: "prompt",
					message: payload.text,
					images: payload.images,
				}).catch(reject);
			});

			const finalText = this.activeRun?.text?.trim() || (await this.getLastAssistantText());
			await publisher.finalize(finalText || "(No assistant text output)");
			await this.sendRunContextMessage(thread);
			await this.sendOutboundFiles(thread, finalText);
		} catch (error) {
			await publisher.fail(formatError(error));
			throw error;
		} finally {
			this.activeRun = null;
		}
	}

	async sendOutboundFiles(thread, text) {
		const paths = extractAttachmentMarkers(text || "");
		if (paths.length === 0) return;
		const files = [];
		for (const filePath of paths.slice(0, MAX_OUTBOUND_FILES)) {
			try {
				const info = await stat(filePath);
				if (!info.isFile()) continue;
				if (info.size > MAX_OUTBOUND_FILE_BYTES) {
					await sendDiscordMessage(thread, `Skipping file over 8MB: ${filePath}`, "outbound-file-skip");
					continue;
				}
				files.push(
					new AttachmentBuilder(filePath, {
						name: sanitizeFileName(filePath),
					}),
				);
			} catch {
				await sendDiscordMessage(thread, `Could not attach missing file: ${filePath}`, "outbound-file-missing");
			}
		}
		if (files.length > 0) {
			await sendDiscordMessage(
				thread,
				{
					content: "Attached generated file(s):",
					files,
				},
				"outbound-file-attach",
			);
		}
	}

	async sendRunContextMessage(thread) {
		try {
			const state = await this.sendRpc({ type: "get_state" });
			this.lastKnownState = state || this.lastKnownState;
		} catch {}

		const contextLine = formatDiscordContextLine({
			usage: this.sessionUsageTotals,
			contextUsage: this.contextUsageEstimate,
			contextWindow: this.lastKnownState?.model?.contextWindow,
			autoCompactionEnabled: this.lastKnownState?.autoCompactionEnabled,
		});
		if (!contextLine) return;
		await sendDiscordMessage(thread, contextLine, "run-context");
	}

	async getLastAssistantText() {
		try {
			const result = await this.sendRpc({ type: "get_last_assistant_text" });
			if (result && typeof result.text === "string") return result.text.trim();
		} catch {}
		return "";
	}


	async stop() {
		const proc = this.proc;
		this.proc = null;
		this.stdin = null;
		this.activeRun = null;
		this.pendingById.clear();
		if (!proc) return;
		proc.kill("SIGTERM");
		await delay(200);
		if (!proc.killed) proc.kill("SIGKILL");
	}
}

class DiscordRunPublisher {
	constructor(thread) {
		this.thread = thread;
		this.statusMessage = null;
		this.assistantText = "";
		this.assistantMessages = [];
		this.toolStates = new Map();
		this.lastAssistantRenderAt = 0;
		this.renderQueue = Promise.resolve();
	}

	enqueueRender(op) {
		const run = this.renderQueue.then(op, op);
		this.renderQueue = run.catch(() => undefined);
		return run;
	}

	async start() {
		await this.enqueueRender(async () => {
			await this.updateStatus("Working...");
		});
	}

	async onText(fullText) {
		await this.enqueueRender(async () => {
			this.assistantText = fullText;
			await this.renderAssistant(false);
		});
	}

	async onEvent(event) {
		await this.enqueueRender(async () => {
			if (!event || typeof event !== "object") return;
			if (event.type === "tool_execution_start") {
				await this.updateToolState(
					event.toolCallId,
					{
						toolName: event.toolName,
						args: event.args,
						isDone: false,
						isError: false,
					},
					true,
				);
				return;
			}
			if (event.type === "tool_execution_update") {
				return;
			}
			if (event.type === "tool_execution_end") {
				await this.updateToolState(
					event.toolCallId,
					{
						toolName: event.toolName,
						isDone: true,
						isError: Boolean(event.isError),
					},
					true,
				);
			}
		});
	}

	async updateToolState(toolCallId, patch, forceRender) {
		const now = Date.now();
		const existing = this.toolStates.get(toolCallId) || {
			messages: [],
			toolName: "tool",
			args: null,
			isDone: false,
			isError: false,
			lastRenderAt: 0,
		};
		const next = { ...existing, ...patch };
		this.toolStates.set(toolCallId, next);
		if (!forceRender && now - next.lastRenderAt < TOOL_UPDATE_DEBOUNCE_MS) return;

		const heading = `🛠️ ${next.toolName}`;
		const renderedArgs = renderToolArgs(next.toolName, next.args);
		const argsText = renderedArgs ? `Args:\n${renderedArgs}` : "";
		const statusText = next.isDone ? (next.isError ? "Error" : "Done") : "";
		const body = [heading, argsText, statusText].filter(Boolean).join("\n\n");
		const content = body || heading;
		await this.syncChunkedMessages(next.messages, content);
		next.lastRenderAt = Date.now();
	}

	async renderAssistant(force) {
		const now = Date.now();
		if (!force && now - this.lastAssistantRenderAt < TEXT_UPDATE_DEBOUNCE_MS) return;
		const text = this.assistantText.trim();
		if (!text) return;
		await this.syncChunkedMessages(this.assistantMessages, text);
		this.lastAssistantRenderAt = Date.now();
	}

	async syncChunkedMessages(messages, content) {
		const chunks = chunkText(content, MAX_MESSAGE_CHARS);
		for (let i = 0; i < chunks.length; i += 1) {
			if (!messages[i]) {
				const created = await sendDiscordMessage(this.thread, chunks[i], "publisher-chunk");
				if (!created) return;
				messages[i] = created;
				continue;
			}
			await safeEdit(messages[i], chunks[i]);
		}
		for (let i = chunks.length; i < messages.length; i += 1) {
			const stale = messages[i];
			if (!stale) continue;
			try {
				await stale.delete();
			} catch {}
		}
		messages.length = chunks.length;
	}

	async updateStatus(content) {
		if (!this.statusMessage) {
			this.statusMessage = await sendDiscordMessage(this.thread, content, "publisher-status");
			return;
		}
		await safeEdit(this.statusMessage, content);
	}

	async finalize(finalText) {
		await this.enqueueRender(async () => {
			this.assistantText = finalText || this.assistantText;
			await this.renderAssistant(true);
			await this.updateStatus("Done.");
		});
	}

	async fail(error) {
		await this.enqueueRender(async () => {
			await this.updateStatus(`Error: ${error || "Unknown error"}`);
		});
	}
}

async function buildInboundPayload(message, threadId) {
	const images = [];
	const attachmentNotes = [];
	for (const attachment of message.attachments.values()) {
		const { fileName, contentType, url } = attachment;
		if (!url) continue;
		if (isImageAttachment(contentType, fileName)) {
			try {
				const image = await downloadImageAsBase64(url, contentType || guessMimeType(fileName));
				images.push(image);
				attachmentNotes.push(`Image attached: ${fileName}`);
			} catch (error) {
				attachmentNotes.push(`Failed to fetch image attachment ${fileName}: ${formatError(error)}`);
			}
			continue;
		}
		try {
			const localPath = await downloadFileToThreadFolder(url, threadId, fileName || "attachment.bin");
			attachmentNotes.push(`Attachment saved to ${localPath}`);
		} catch (error) {
			attachmentNotes.push(`Failed to fetch attachment ${fileName}: ${formatError(error)}`);
		}
	}

	const bodyText = (message.content || "").trim();
	const parts = [];
	if (bodyText) parts.push(bodyText);
	if (attachmentNotes.length > 0) {
		parts.push("\nAttachments:\n" + attachmentNotes.map((line) => `- ${line}`).join("\n"));
	}
	if (!bodyText && images.length > 0) {
		parts.push("User sent image attachment(s). Analyze the attached image(s).");
	}
	const text = parts.join("\n").trim();
	if (!text && images.length === 0) return null;
	return { text: text || "User sent attachment(s).", images };
}

function loadEnv(filePath, requiredKeys) {
	if (!existsSync(filePath)) {
		return { ok: false, error: `Missing .env at ${filePath}` };
	}
	const raw = readFileSyncSafe(filePath);
	const values = {};
	for (const line of raw.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const idx = trimmed.indexOf("=");
		if (idx <= 0) continue;
		const key = trimmed.slice(0, idx).trim();
		let value = trimmed.slice(idx + 1).trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		values[key] = value;
	}
	for (const key of requiredKeys) {
		if (!values[key]) return { ok: false, error: `Missing required ${key} in ${filePath}` };
	}
	return { ok: true, values };
}

function readFileSyncSafe(filePath) {
	try {
		return readFileSync(filePath, "utf8");
	} catch {
		return "";
	}
}

async function sendDiscordMessage(target, payload, source = "send") {
	if (!target || typeof target.send !== "function") return null;
	if (!(await ensureOwnershipOrShutdown(`outbound:${source}`))) return null;
	try {
		return await target.send(payload);
	} catch {
		return null;
	}
}

async function safeEdit(message, content) {
	if (!message || typeof message.edit !== "function") return;
	if (!(await ensureOwnershipOrShutdown("outbound:edit"))) return;
	try {
		await message.edit(content);
	} catch {}
}

async function safeReply(message, content) {
	if (!(await ensureOwnershipOrShutdown("outbound:reply"))) return;
	try {
		await message.reply(content);
	} catch {}
}

async function safeInteractionReply(interaction, payload) {
	if (!(await ensureOwnershipOrShutdown("outbound:interaction-reply"))) return;
	try {
		await interaction.reply(payload);
	} catch {}
}

async function safeInteractionEditReply(interaction, content) {
	if (!(await ensureOwnershipOrShutdown("outbound:interaction-edit"))) return;
	try {
		await interaction.editReply(content);
	} catch (error) {
		if (isDiscordUnknownMessageError(error)) return;
		throw error;
	}
}

async function getStarterMessage(thread) {
	try {
		const starter = await thread.fetchStarterMessage();
		if (starter) return starter;
	} catch {}

	try {
		if (thread.parent?.messages?.fetch) {
			const fromParent = await thread.parent.messages.fetch(thread.id);
			if (fromParent) return fromParent;
		}
	} catch {}

	return null;
}

function buildThreadName(seed) {
	const cleaned = String(seed || "pi session").replace(/\s+/g, " ").trim();
	return truncate(cleaned || "pi session", 90);
}

function truncate(text, max = 2000) {
	const value = String(text || "");
	if (value.length <= max) return value;
	return `${value.slice(0, max - 1)}…`;
}

function parsePositiveInt(value) {
	const n = Number(value);
	if (!Number.isInteger(n) || n <= 0) return null;
	return n;
}

function safeJson(value) {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function renderToolArgs(toolName, args) {
	if (args == null) return "";
	if (toolName !== "edit") return safeJson(args);
	if (!args || typeof args !== "object") return safeJson(args);

	const edits = Array.isArray(args.edits) ? args.edits : null;
	if (!edits) return safeJson(args);

	const oldLines = edits.reduce((sum, edit) => sum + countLines(edit?.oldText), 0);
	const newLines = edits.reduce((sum, edit) => sum + countLines(edit?.newText), 0);
	const summary = {
		path: typeof args.path === "string" ? args.path : undefined,
		edits: edits.length,
		lines: {
			old: oldLines,
			new: newLines,
		},
	};
	return safeJson(summary);
}

function countLines(value) {
	if (typeof value !== "string" || value.length === 0) return 0;
	return value.split(/\r?\n/).length;
}

function chunkText(text, maxLen = MAX_MESSAGE_CHARS) {
	const value = String(text || "");
	if (!value) return [""];
	const chunks = [];
	let remaining = value;
	while (remaining.length > maxLen) {
		let split = remaining.lastIndexOf("\n", maxLen);
		if (split < Math.floor(maxLen * 0.4)) split = maxLen;
		chunks.push(remaining.slice(0, split).trimEnd());
		remaining = remaining.slice(split).trimStart();
	}
	chunks.push(remaining);
	return chunks.filter((chunk) => chunk.length > 0);
}

function extractToolText(result) {
	if (!result || typeof result !== "object") return "";
	if (!Array.isArray(result.content)) return "";
	const lines = [];
	for (const block of result.content) {
		if (!block || typeof block !== "object") continue;
		if (block.type !== "text") continue;
		if (typeof block.text !== "string") continue;
		lines.push(block.text);
	}
	return lines.join("\n").trim();
}

function clipToLastLines(text, maxLines) {
	const lines = String(text || "").split("\n");
	if (lines.length <= maxLines) return lines.join("\n");
	return lines.slice(lines.length - maxLines).join("\n");
}

function extractAttachmentMarkers(text) {
	const lines = String(text || "").split(/\r?\n/);
	const paths = [];
	for (const line of lines) {
		const match = line.match(/^\s*DISCORD_ATTACH:\s*(.+?)\s*$/);
		if (!match) continue;
		const maybePath = match[1].trim();
		if (!maybePath.startsWith("/")) continue;
		paths.push(maybePath);
	}
	return Array.from(new Set(paths));
}

function sanitizeFileName(filePath) {
	const base = filePath.split(/[\\/]/).pop() || "file";
	return base.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function formatError(error) {
	if (!error) return "Unknown error";
	if (error instanceof Error) return error.message;
	return String(error);
}

function isDiscordUnknownMessageError(error) {
	return Boolean(error && typeof error === "object" && error.code === 10008);
}

function createUsageTotals() {
	return {
		input: 0,
		output: 0,
		reasoning: 0,
		cost: {
			total: 0,
		},
	};
}

function mergeUsageTotals(current, usage) {
	const base = current && typeof current === "object" ? current : createUsageTotals();
	const normalized = normalizeUsage(usage);
	return {
		input: Number(base.input || 0) + normalized.input,
		output: Number(base.output || 0) + normalized.output,
		reasoning: Number(base.reasoning || 0) + normalized.reasoning,
		cost: {
			total: Number(base?.cost?.total || 0) + Number(normalized?.cost?.total || 0),
		},
	};
}

function normalizeUsage(usage) {
	return {
		input: Number(usage?.input || 0),
		output: Number(usage?.output || 0),
		reasoning: Number(usage?.reasoning || usage?.reasoningTokens || 0),
		cost: {
			total: Number(usage?.cost?.total || 0),
		},
	};
}

function extractFinalAssistantMessage(agentEndEvent) {
	if (!agentEndEvent || typeof agentEndEvent !== "object") return null;
	const messages = Array.isArray(agentEndEvent.messages) ? agentEndEvent.messages : [];
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const message = messages[i];
		if (!message || typeof message !== "object") continue;
		if (message.role !== "assistant") continue;
		return message;
	}
	return null;
}

function formatDiscordContextLine({ usage, contextUsage, contextWindow, autoCompactionEnabled }) {
	if (!usage || typeof usage !== "object") return "";
	const input = Number(usage.input || 0);
	const output = Number(usage.output || 0);
	const reasoning = Number(usage.reasoning || usage.reasoningTokens || 0);
	const totalCost = Number(usage?.cost?.total || 0);

	const contextInput = Number(contextUsage?.input || 0);
	const contextOutput = Number(contextUsage?.output || 0);
	const contextReasoning = Number(contextUsage?.reasoning || contextUsage?.reasoningTokens || 0);

	const parts = [];
	parts.push(`↑${formatCompactNumber(input)}`);
	parts.push(`↓${formatCompactNumber(output)}`);
	if (reasoning > 0) parts.push(`R${formatCompactNumber(reasoning)}`);
	if (totalCost > 0) parts.push(`$${formatCost(totalCost)} (sub)`);
	if (typeof contextWindow === "number" && contextWindow > 0) {
		const usedForPercent = Math.max(0, contextInput + contextOutput + contextReasoning);
		const pct = usedForPercent > 0 ? `${((usedForPercent / contextWindow) * 100).toFixed(1)}%` : "0.0%";
		const compactLabel = autoCompactionEnabled ? " (auto)" : "";
		parts.push(`${pct}/${formatCompactNumber(contextWindow)}${compactLabel}`);
	}
	if (parts.length === 0) return "";
	return `ℹ️ Context: ${parts.join(" ")}`;
}

function formatCompactNumber(value) {
	const num = Number(value || 0);
	if (!Number.isFinite(num) || num <= 0) return "0";
	if (num < 1000) return String(Math.round(num));
	if (num < 1_000_000) return `${trimTrailingZero((num / 1000).toFixed(1))}k`;
	return `${trimTrailingZero((num / 1_000_000).toFixed(1))}M`;
}

function formatCost(value) {
	const num = Number(value || 0);
	if (!Number.isFinite(num) || num <= 0) return "0";
	if (num >= 1) return num.toFixed(2);
	if (num >= 0.1) return num.toFixed(3);
	return num.toFixed(4);
}

function trimTrailingZero(text) {
	return String(text).replace(/\.0$/, "");
}

function isImageAttachment(contentType, fileName) {
	const mime = String(contentType || "").toLowerCase();
	if (mime.startsWith("image/")) return true;
	const ext = extname(String(fileName || "")).toLowerCase();
	return [".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(ext);
}

function guessMimeType(fileName) {
	const ext = extname(String(fileName || "")).toLowerCase();
	if (ext === ".png") return "image/png";
	if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
	if (ext === ".gif") return "image/gif";
	if (ext === ".webp") return "image/webp";
	return "application/octet-stream";
}

async function downloadImageAsBase64(url, mimeType) {
	const res = await fetch(url);
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	const arr = await res.arrayBuffer();
	return {
		type: "image",
		data: Buffer.from(arr).toString("base64"),
		mimeType,
	};
}

async function downloadFileToThreadFolder(url, threadId, fileName) {
	const dir = join(INCOMING_DIR, threadId);
	await mkdir(dir, { recursive: true });
	const safeName = sanitizeFileName(fileName);
	const localPath = join(dir, `${Date.now()}-${safeName}`);
	const res = await fetch(url);
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	const arr = await res.arrayBuffer();
	await writeFile(localPath, Buffer.from(arr));
	return localPath;
}
