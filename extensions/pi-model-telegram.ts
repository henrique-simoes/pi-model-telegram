/**
 * pi-model-telegram
 *
 * Brings pi's provider and model management to a Telegram chat that is
 * connected through the pi-chat extension.
 *
 * How it works
 * ------------
 * pi-chat hands every inbound chat message to pi with `pi.sendUserMessage()`,
 * which raises the `input` event with `source: "extension"`. The documented
 * lifecycle checks that event before the model runs, and a handler may return
 * `{ action: "handled" }` to answer without an LLM turn. That is what makes
 * `/login` usable when no provider is authenticated yet: with an empty
 * auth.json no agent turn can happen at all, so a tool-based approach could
 * never reply.
 *
 * Because a handled input never produces assistant output, pi-chat has nothing
 * to deliver. This extension therefore writes its own replies straight to the
 * Telegram Bot API, reusing the bot token pi-chat already stores. It only
 * sends; pi-chat keeps sole ownership of receiving (long polling), so there is
 * no getUpdates conflict.
 */

import { readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const AGENT_HOME = join(homedir(), ".pi", "agent");
const AUTH_FILE = join(AGENT_HOME, "auth.json");
const CHAT_CONFIG = join(AGENT_HOME, "chat", "config.json");

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Commands pi-chat consumes itself; never shadow them. */
const RESERVED = new Set(["stop", "new", "compact", "status"]);

/** Commands this extension owns. */
const COMMANDS = new Set([
	"help", "model", "thinking", "login", "logout", "providers", "whichmodel", "cancel",
]);

const PAGE = 20;

/**
 * API-key providers, transcribed from pi's own docs/providers.md.
 *
 * The model catalogue is empty until a provider is authenticated, so
 * `ctx.modelRegistry.getAvailable()` cannot bootstrap /login - the exact case
 * /login exists for. This table gives a starting list; anything the catalogue
 * reports at runtime is merged in on top.
 */
const API_KEY_PROVIDERS: Array<{ key: string; label: string }> = [
	{ key: "anthropic", label: "Anthropic" },
	{ key: "openai", label: "OpenAI" },
	{ key: "google", label: "Google Gemini" },
	{ key: "xai", label: "xAI" },
	{ key: "openrouter", label: "OpenRouter" },
	{ key: "deepseek", label: "DeepSeek" },
	{ key: "mistral", label: "Mistral" },
	{ key: "groq", label: "Groq" },
	{ key: "cerebras", label: "Cerebras" },
	{ key: "fireworks", label: "Fireworks" },
	{ key: "together", label: "Together AI" },
	{ key: "baseten", label: "Baseten" },
	{ key: "nvidia", label: "NVIDIA NIM" },
	{ key: "huggingface", label: "Hugging Face" },
	{ key: "vercel-ai-gateway", label: "Vercel AI Gateway" },
	{ key: "amazon-bedrock", label: "Amazon Bedrock" },
	{ key: "azure-openai-responses", label: "Azure OpenAI Responses" },
	{ key: "cloudflare-ai-gateway", label: "Cloudflare AI Gateway" },
	{ key: "cloudflare-workers-ai", label: "Cloudflare Workers AI" },
	{ key: "ant-ling", label: "Ant Ling" },
	{ key: "zai", label: "ZAI Coding Plan (Global)" },
	{ key: "zai-coding-cn", label: "ZAI Coding Plan (China)" },
	{ key: "opencode", label: "OpenCode Zen" },
	{ key: "opencode-go", label: "OpenCode Go" },
	{ key: "radius", label: "Radius" },
	{ key: "kimi-coding", label: "Kimi For Coding" },
	{ key: "minimax", label: "MiniMax" },
	{ key: "minimax-cn", label: "MiniMax (China)" },
	{ key: "qwen-token-plan", label: "Qwen Token Plan" },
	{ key: "qwen-token-plan-individual", label: "Qwen Token Plan (Individual)" },
	{ key: "qwen-token-plan-cn", label: "Qwen Token Plan (China)" },
	{ key: "xiaomi", label: "Xiaomi MiMo" },
	{ key: "xiaomi-token-plan-cn", label: "Xiaomi MiMo Token Plan (China)" },
	{ key: "xiaomi-token-plan-ams", label: "Xiaomi MiMo Token Plan (Amsterdam)" },
	{ key: "xiaomi-token-plan-sgp", label: "Xiaomi MiMo Token Plan (Singapore)" },
];

/** Documented providers first, then anything extra the catalogue knows about. */
export function knownProviders(catalogue: string[]): Array<{ key: string; label: string }> {
	const seen = new Set(API_KEY_PROVIDERS.map((entry) => entry.key));
	const extra = [...new Set(catalogue)].filter((name) => !seen.has(name)).sort();
	return [...API_KEY_PROVIDERS, ...extra.map((name) => ({ key: name, label: name }))];
}


type Pending =
	| { kind: "model"; items: Array<{ provider: string; id: string }> }
	| { kind: "thinking" }
	| { kind: "login"; providers: string[] }
	| { kind: "apikey"; provider: string };

let pending: Pending | undefined;

// ---------------------------------------------------------------- chat wiring

interface ChatTarget {
	token: string;
	chatId: string;
	accountId: string;
	channelKey: string;
}

/** pi-chat spawns each worker with `--chat-conversation <conversationId>`. */
function conversationIdFromArgv(): string | undefined {
	const argv = process.argv;
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--chat-conversation") return argv[i + 1];
		const inline = /^--chat-conversation=(.*)$/.exec(argv[i] ?? "");
		if (inline) return inline[1];
	}
	return undefined;
}

export function sanitize(value: string): string {
	return value.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
}

/**
 * Resolve the Telegram account and channel for this worker.
 *
 * pi rewrites its process title, so `--chat-conversation` is not visible in
 * /proc and `process.argv` cannot be relied on alone. Fall back in order:
 *   1. the `--chat-conversation` flag, when the runtime still exposes it;
 *   2. the only configured Telegram channel, when there is exactly one;
 *   3. the channel whose pi-chat log was written most recently, which is the
 *      one that just delivered the message being handled.
 */
function resolveTarget(): ChatTarget | undefined {
	let config: any;
	try {
		config = JSON.parse(readFileSync(CHAT_CONFIG, "utf8"));
	} catch {
		return undefined;
	}

	const channels: ChatTarget[] = [];
	for (const [accountId, account] of Object.entries<any>(config.accounts ?? {})) {
		if (account?.service !== "telegram" || !account?.botToken) continue;
		for (const [channelKey, channel] of Object.entries<any>(account.channels ?? {})) {
			if (!channel?.id) continue;
			channels.push({ token: account.botToken, chatId: String(channel.id), accountId, channelKey });
		}
	}
	if (channels.length === 0) return undefined;

	const conversationId = conversationIdFromArgv();
	if (conversationId) {
		for (const candidate of channels) {
			const joined = [":", "/", "|", "#", "_", "-"].map(
				(sep) => `${candidate.accountId}${sep}${candidate.channelKey}`,
			);
			if (
				joined.includes(conversationId) ||
				joined.some((value) => sanitize(value) === sanitize(conversationId))
			) {
				return candidate;
			}
		}
	}

	if (channels.length === 1) return channels[0];

	let newest: ChatTarget | undefined;
	let newestAt = -1;
	for (const candidate of channels) {
		try {
			const stamp = statSync(channelLogPath(candidate)).mtimeMs;
			if (stamp > newestAt) {
				newestAt = stamp;
				newest = candidate;
			}
		} catch {
			// channel has no log yet
		}
	}
	return newest;
}

function channelLogPath(target: ChatTarget): string {
	return join(
		AGENT_HOME, "chat", "accounts", target.accountId, "channels", target.channelKey, "channel.jsonl",
	);
}

async function send(target: ChatTarget, text: string): Promise<void> {
	try {
		await fetch(`https://api.telegram.org/bot${target.token}/sendMessage`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ chat_id: target.chatId, text, disable_web_page_preview: true }),
		});
	} catch {
		// Never let a delivery failure break the worker.
	}
}

/**
 * Best-effort removal of a message from the Telegram chat. Used for the message
 * carrying an API key. The id is not in the prompt, so read the newest inbound
 * record from pi-chat's channel log.
 */
async function deleteLastInbound(target: ChatTarget): Promise<boolean> {
	const log = channelLogPath(target);
	let messageId: string | undefined;
	try {
		const lines = readFileSync(log, "utf8").trim().split("\n");
		for (let i = lines.length - 1; i >= 0; i--) {
			const record = JSON.parse(lines[i] as string);
			if (record?.type === "inbound" && record?.messageId) {
				messageId = String(record.messageId);
				break;
			}
		}
	} catch {
		return false;
	}
	if (!messageId) return false;
	try {
		const response = await fetch(`https://api.telegram.org/bot${target.token}/deleteMessage`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ chat_id: target.chatId, message_id: Number(messageId) }),
		});
		const body: any = await response.json();
		return body?.ok === true;
	} catch {
		return false;
	}
}

// ------------------------------------------------------------------ auth file

function readAuth(): Record<string, any> {
	try {
		const parsed = JSON.parse(readFileSync(AUTH_FILE, "utf8"));
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

/**
 * `key` supports `!command` and `$VAR` expansion, so a literal secret that
 * begins with either must be escaped or pi would execute or interpolate it.
 */
export function escapeKey(raw: string): string {
	if (raw.startsWith("$")) return `$$${raw.slice(1)}`;
	if (raw.startsWith("!")) return `$!${raw.slice(1)}`;
	return raw;
}

function writeAuth(auth: Record<string, any>): void {
	mkdirSync(dirname(AUTH_FILE), { recursive: true });
	writeFileSync(AUTH_FILE, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });
}

// -------------------------------------------------------------- prompt parser

/**
 * pi-chat formats each inbound message as
 *   `- [<timestamp>] [uid:<userId>] <userName>: <text>`
 * and batches every message received since the last completed job into ONE
 * prompt. Reading only the final line silently drops a command that arrived
 * with others, so return the whole batch, oldest first.
 */
export function transcriptTexts(prompt: string): string[] {
	const pattern = /^- \[[^\]]*\] \[uid:[^\]]*\] [^:]*: ([\s\S]*)$/;
	const found: string[] = [];
	for (const line of prompt.split("\n")) {
		const match = pattern.exec(line);
		if (match) found.push((match[1] ?? "").trim());
	}
	return found;
}

export function lastUserText(prompt: string): string | undefined {
	const all = transcriptTexts(prompt);
	return all.length ? all[all.length - 1] : undefined;
}

/** Newest recognised command in a batch, so a burst of messages still works. */
export function pickCommand(prompt: string, commands: Set<string>): string | undefined {
	const all = transcriptTexts(prompt);
	for (let i = all.length - 1; i >= 0; i--) {
		const text = all[i] as string;
		const word = (text.split(/\s+/)[0] ?? "").replace(/^\//, "").toLowerCase();
		if (commands.has(word)) return text;
	}
	return undefined;
}

// ------------------------------------------------------------------- renderer

function providerState(ctx: any, provider: string): string {
	try {
		const auth = ctx.modelRegistry?.getProviderAuth?.(provider);
		return auth?.apiKey || auth?.headers || auth?.baseUrl ? "authenticated" : "not authenticated";
	} catch {
		return "unknown";
	}
}

function listModels(ctx: any): Array<{ provider: string; id: string }> {
	// The catalogue is empty and its accessors can throw before any provider is
	// authenticated. Never let that escape: it would abort the handler, pi would
	// swallow the error, and the user would see silence.
	try {
		const scoped = Array.isArray(ctx?.scopedModels) ? ctx.scopedModels : [];
		const source =
			scoped.length > 0 ? scoped.map((entry: any) => entry?.model) : (ctx?.modelRegistry?.getAvailable?.() ?? []);
		if (!Array.isArray(source)) return [];
		return source
			.filter((model: any) => model?.provider && model?.id)
			.map((model: any) => ({ provider: String(model.provider), id: String(model.id) }));
	} catch {
		return [];
	}
}

function numbered(items: string[]): string {
	return items.map((item, index) => `${index + 1}. ${item}`).join("\n");
}

const HELP = [
	"pi model control",
	"",
	"/model [filter]  - list and switch model",
	"/thinking        - list and set thinking level",
	"/login           - authenticate a provider with an API key",
	"/logout <name>   - remove a provider credential",
	"/providers       - show providers and auth state",
	"/whichmodel      - show the active model and thinking level",
	"/help            - this message",
	"",
	"Reply with a number to pick from a list. Send 'cancel' to abort.",
	"pi-chat still owns stop, new, compact and status.",
].join("\n");

// ------------------------------------------------------------------ extension

export default function (pi: any) {
	pi.on("input", async (event: any, ctx: any) => {
		// Only messages pi-chat delivered, and only when the payload really is a
		// pi-chat transcript line. That pairing is what keeps this extension
		// inert in the terminal, where pi's own /login and /model must win.
		if (event?.source !== "extension") return;
		const text = lastUserText(String(event.text ?? ""));
		if (!text) return;

		const target = resolveTarget();
		if (!target) return;

		// A burst of messages arrives as one batch; act on the newest command in
		// it rather than only the final line.
		const chosen = pending ? text : (pickCommand(String(event.text ?? ""), COMMANDS) ?? text);

		const lower = chosen.toLowerCase();
		const [rawCommand = "", ...rest] = chosen.split(/\s+/);
		const command = rawCommand.replace(/^\//, "").toLowerCase();
		const argument = rest.join(" ").trim();

		if (!pending && !COMMANDS.has(command)) return;

		if (RESERVED.has(command)) return;

		try {
		// ---- continuation of a pending selection
		if (pending) {
			if (lower === "cancel") {
				pending = undefined;
				await send(target, "Cancelled.");
				return { action: "handled" };
			}

			if (pending.kind === "apikey") {
				const provider = pending.provider;
				pending = undefined;
				const auth = readAuth();
				auth[provider] = { type: "api_key", key: escapeKey(chosen) };
				try {
					writeAuth(auth);
				} catch (error: any) {
					await send(target, `Could not write auth.json: ${error?.message ?? error}`);
					return { action: "handled" };
				}
				const removed = await deleteLastInbound(target);
				await send(
					target,
					[
						`Stored an API key for ${provider}.`,
						removed
							? "Your message with the key was deleted from this chat."
							: "Could not delete your message automatically - please delete it yourself.",
						"The key is also recorded in this channel's local pi-chat log.",
						"Run /model to pick a model, then send a normal message to test it.",
					].join("\n"),
				);
				return { action: "handled" };
			}

			const choice = Number.parseInt(chosen, 10);
			if (!Number.isFinite(choice)) {
				await send(target, "Reply with a number from the list, or 'cancel'.");
				return { action: "handled" };
			}

			if (pending.kind === "model") {
				const picked = pending.items[choice - 1];
				pending = undefined;
				if (!picked) {
					await send(target, "That number is not on the list.");
					return { action: "handled" };
				}
				const model = ctx.modelRegistry?.find?.(picked.provider, picked.id);
				if (!model) {
					await send(target, `Model ${picked.provider}/${picked.id} is no longer available.`);
					return { action: "handled" };
				}
				const ok = await pi.setModel(model);
				await send(
					target,
					ok
						? `Model set to ${picked.provider}/${picked.id}.`
						: `No credentials configured for ${picked.provider}. Run /login first.`,
				);
				return { action: "handled" };
			}

			if (pending.kind === "thinking") {
				const level = THINKING_LEVELS[choice - 1];
				pending = undefined;
				if (!level) {
					await send(target, "That number is not on the list.");
					return { action: "handled" };
				}
				pi.setThinkingLevel(level);
				await send(target, `Thinking level set to ${level}.`);
				return { action: "handled" };
			}

			if (pending.kind === "login") {
				const provider = pending.providers[choice - 1];
				if (!provider) {
					pending = undefined;
					await send(target, "That number is not on the list.");
					return { action: "handled" };
				}
				pending = { kind: "apikey", provider };
				await send(
					target,
					[
						`Send the API key for ${provider} as your next message.`,
						"",
						"Warning: the key will pass through Telegram and be written to this",
						"channel's local chat log. This extension deletes your message when it",
						"can, but Telegram may still retain it. For the strongest handling use",
						"/login in pi's terminal session instead.",
						"",
						"Send 'cancel' to abort.",
					].join("\n"),
				);
				return { action: "handled" };
			}
		}

		// ---- commands
			switch (command) {
			case "help":
				await send(target, HELP);
				return { action: "handled" };

			case "whichmodel": {
				const model = ctx.model;
				await send(
					target,
					model
						? `Model: ${model.provider}/${model.id}\nThinking: ${ctx.thinkingLevel ?? "unknown"}`
						: "No model is currently active. Run /login, then /model.",
				);
				return { action: "handled" };
			}

			case "providers": {
				const catalogue = [...new Set(listModels(ctx).map((entry) => entry.provider))];
				const stored = Object.keys(readAuth());
				const rows = knownProviders(catalogue)
					.filter((entry) => stored.includes(entry.key) || catalogue.includes(entry.key))
					.map((entry) => `- ${entry.label} (${entry.key}): ${providerState(ctx, entry.key)}`);
				await send(
					target,
					rows.length
						? `Configured providers:\n${rows.join("\n")}`
						: "No provider is configured yet. Run /login to add one.",
				);
				return { action: "handled" };
			}

			case "model": {
				let models = listModels(ctx);
				if (argument) {
					const needle = argument.toLowerCase();
					models = models.filter((entry) => `${entry.provider}/${entry.id}`.toLowerCase().includes(needle));
				}
				if (models.length === 0) {
					await send(
						target,
						argument
							? `No model matches "${argument}".`
							: "No models are available yet. Authenticate a provider with /login first.",
					);
					return { action: "handled" };
				}
				const shown = models.slice(0, PAGE);
				pending = { kind: "model", items: shown };
				const active = ctx.model ? `\n\nActive: ${ctx.model.provider}/${ctx.model.id}` : "";
				const more =
					models.length > shown.length
						? `\n\n${models.length - shown.length} more. Narrow with /model <filter>.`
						: "";
				await send(
					target,
					`Select a model:\n${numbered(shown.map((entry) => `${entry.provider}/${entry.id}`))}${more}${active}`,
				);
				return { action: "handled" };
			}

			case "thinking": {
				pending = { kind: "thinking" };
				await send(
					target,
					`Select a thinking level:\n${numbered([...THINKING_LEVELS])}\n\nActive: ${ctx.thinkingLevel ?? "unknown"}`,
				);
				return { action: "handled" };
			}

			case "login": {
				const catalogue = [...new Set(listModels(ctx).map((entry) => entry.provider))];
				let providers = knownProviders(catalogue);
				if (argument) {
					const needle = argument.toLowerCase();
					providers = providers.filter(
						(entry) =>
							entry.key.toLowerCase().includes(needle) || entry.label.toLowerCase().includes(needle),
					);
				}
				if (providers.length === 0) {
					await send(target, `No provider matches "${argument}".`);
					return { action: "handled" };
				}
				const shown = providers.slice(0, PAGE);
				pending = { kind: "login", providers: shown.map((entry) => entry.key) };
				const more =
					providers.length > shown.length
						? `\n\n${providers.length - shown.length} more. Narrow with /login <filter>.`
						: "";
				await send(
					target,
					[
						"Select a provider to authenticate with an API key:",
						numbered(shown.map((entry) => `${entry.label} (${providerState(ctx, entry.key)})`)),
						more,
						"",
						"Subscription and OAuth sign-in are not available over chat;",
						"use /login in pi's terminal session for those.",
					].join("\n"),
				);
				return { action: "handled" };
			}

			case "logout": {
				if (!argument) {
					await send(target, "Usage: /logout <provider>");
					return { action: "handled" };
				}
				const auth = readAuth();
				if (!(argument in auth)) {
					await send(target, `No stored credential for ${argument}.`);
					return { action: "handled" };
				}
				delete auth[argument];
				writeAuth(auth);
				await send(target, `Removed the stored credential for ${argument}.`);
				return { action: "handled" };
			}

			default:
				return;
			}
		} catch (error: any) {
			// pi swallows errors thrown by an input handler, which would leave the
			// user staring at silence. Surface it in the chat instead.
			pending = undefined;
			await send(target, `pi-model-telegram failed: ${error?.message ?? String(error)}`);
			return { action: "handled" };
		}
	});
}
