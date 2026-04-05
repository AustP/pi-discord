import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";

const STATUS_KEY = "discord-mode";
const SERVICE_READY_TIMEOUT_MS = 20_000;
const EXTENSION_DIR = __dirname;
const PROJECT_ROOT = path.resolve(EXTENSION_DIR, "..");
const SERVICE_PATH = path.join(PROJECT_ROOT, "service", "discord-bridge.mjs");

type UIContext = {
	ui: {
		setStatus: (key: string, value: string | undefined) => void;
		notify: (message: string, level?: "info" | "success" | "warning" | "error") => void;
	};
};

export default function (pi: ExtensionAPI) {
	let enabled = false;
	let service: ChildProcessWithoutNullStreams | null = null;
	let startupPromise: Promise<void> | null = null;
	let lastCtx: UIContext | null = null;

	const setStatus = (ctx: UIContext, state: "off" | "loading" | "on") => {
		ctx.ui.setStatus(STATUS_KEY, state === "loading" ? "💬 Discord: Loading" : state === "on" ? "💬 Discord: ON" : "💬 Discord: OFF");
	};

	const stopService = async () => {
		startupPromise = null;
		if (!service) return;
		const child = service;
		service = null;
		await new Promise<void>((resolve) => {
			const timeout = setTimeout(() => {
				try {
					child.kill("SIGKILL");
				} catch {}
				resolve();
			}, 1500);
			child.once("exit", () => {
				clearTimeout(timeout);
				resolve();
			});
			try {
				child.kill("SIGTERM");
			} catch {
				clearTimeout(timeout);
				resolve();
			}
		});
	};

	const startService = async (ctx: UIContext) => {
		if (service) return;
		if (startupPromise) return startupPromise;

		startupPromise = new Promise<void>((resolve, reject) => {
			const child = spawn("node", [SERVICE_PATH], {
				cwd: PROJECT_ROOT,
				env: {
					...process.env,
					DISCORD_PI_PWD: process.cwd(),
					DISCORD_PI_PID: String(process.pid),
				},
				stdio: ["ignore", "pipe", "pipe"],
			});
			service = child;

			let buffer = "";
			let settled = false;
			const complete = (fn: () => void) => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				startupPromise = null;
				fn();
			};

			const timeout = setTimeout(() => {
				complete(() => reject(new Error("Timed out waiting for Discord bridge to start.")));
			}, SERVICE_READY_TIMEOUT_MS);

			child.stdout.setEncoding("utf8");
			child.stdout.on("data", (chunk: string) => {
				buffer += chunk;
				while (true) {
					const newline = buffer.indexOf("\n");
					if (newline === -1) break;
					const line = buffer.slice(0, newline).trim();
					buffer = buffer.slice(newline + 1);
					if (!line) continue;
					if (line === "READY") {
						complete(() => resolve());
						continue;
					}
					if (line.startsWith("ERROR:")) {
						complete(() => reject(new Error(line.slice("ERROR:".length).trim() || "Discord bridge startup error.")));
						continue;
					}
				}
			});

			child.stderr.setEncoding("utf8");
			child.stderr.on("data", (chunk: string) => {
				const text = chunk.trim();
				if (!text) return;
				if (/\b(error|failed|exception|fatal)\b/i.test(text)) {
					ctx.ui.notify(`Discord bridge: ${text}`, "error");
				}
			});

			child.on("error", (error) => {
				if (service === child) service = null;
				complete(() => reject(error));
			});

			child.on("exit", (code, signal) => {
				if (service === child) service = null;
				if (!settled) {
					complete(() => reject(new Error(`Discord bridge exited during startup (${code ?? signal ?? "unknown"}).`)));
					return;
				}
				if (enabled && lastCtx) {
					lastCtx.ui.notify(`Discord bridge stopped (${code ?? signal ?? "unknown"}).`, "warning");
					setStatus(lastCtx, "off");
					enabled = false;
				}
			});
		});

		return startupPromise;
	};

	pi.on("session_start", async (_event, ctx) => {
		const typedCtx = ctx as UIContext;
		lastCtx = typedCtx;
		setStatus(typedCtx, "off");
	});

	pi.registerCommand("discord", {
		description: "Toggle Discord bridge service",
		handler: async (_args, ctx) => {
			const typedCtx = ctx as UIContext;
			lastCtx = typedCtx;
			enabled = !enabled;
			if (enabled) {
				setStatus(typedCtx, "loading");
				typedCtx.ui.notify("Starting Discord bridge...", "info");
				try {
					await startService(typedCtx);
					setStatus(typedCtx, "on");
					typedCtx.ui.notify("Discord bridge enabled.", "success");
				} catch (error: any) {
					enabled = false;
					await stopService();
					setStatus(typedCtx, "off");
					typedCtx.ui.notify(`Failed to enable Discord bridge: ${error?.message ?? String(error)}`, "error");
				}
				return;
			}

			await stopService();
			setStatus(typedCtx, "off");
			typedCtx.ui.notify("Discord bridge disabled.", "info");
		},
	});

	pi.on("session_shutdown", async () => {
		enabled = false;
		await stopService();
	});
}
