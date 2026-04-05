#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { REST, Routes, SlashCommandBuilder } from "discord.js";

const PROJECT_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const ENV_PATH = resolve(PROJECT_ROOT, ".env");
const STOP_COMMAND_NAME = "stop";
const DELETE_COMMAND_NAME = "delete";

const requiredEnv = loadEnv(ENV_PATH, ["DISCORD_BOT_TOKEN", "DISCORD_GUILD_ID"]);
if (!requiredEnv.ok) {
	console.error(requiredEnv.error);
	process.exit(1);
}

const { DISCORD_BOT_TOKEN, DISCORD_GUILD_ID } = requiredEnv.values;

const rest = new REST({ version: "10" }).setToken(DISCORD_BOT_TOKEN);

const appInfo = await rest.get(Routes.currentApplication());
const appId = appInfo.id;

const stopCommand = new SlashCommandBuilder()
	.setName(STOP_COMMAND_NAME)
	.setDescription("Stop the active Pi response in this thread immediately")
	.toJSON();
const deleteCommand = new SlashCommandBuilder()
	.setName(DELETE_COMMAND_NAME)
	.setDescription("Delete this Pi thread and its parent starter message")
	.toJSON();

await rest.put(Routes.applicationCommands(appId), { body: [] });
await rest.put(Routes.applicationGuildCommands(appId, DISCORD_GUILD_ID), { body: [stopCommand, deleteCommand] });

const guildCommands = await rest.get(Routes.applicationGuildCommands(appId, DISCORD_GUILD_ID));
console.log(`Synced commands for app ${appId}.`);
console.log(`Guild ${DISCORD_GUILD_ID} commands: ${guildCommands.map((c) => `/${c.name}`).join(", ") || "(none)"}`);
console.log("Global commands: (cleared)");

function loadEnv(filePath, requiredKeys) {
	if (!existsSync(filePath)) {
		return { ok: false, error: `Missing .env at ${filePath}` };
	}
	const raw = readFileSync(filePath, "utf8");
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
