/**
 * pi-model-telegram
 *
 * Provider and model management for a Telegram chat bridged by pi-chat.
 *
 * Two pieces of pi-chat's design shape everything here.
 *
 * 1. Inbound chat text arrives through `pi.sendUserMessage()`, which raises
 *    pi's `input` event before the model runs. That is the only place a
 *    command can be caught when no provider is authenticated yet, because
 *    without credentials no agent turn - and therefore no tool call - can
 *    happen at all.
 *
 * 2. `{ action: "handled" }` must NOT be returned. pi-chat sets an internal
 *    `chatTurnInFlight` flag before dispatching and only clears it from its
 *    `agent_end` handler. Suppressing the turn leaves that flag stuck true and
 *    pi-chat silently ignores every later message. So the turn is allowed to
 *    start and is aborted immediately in `agent_start`; pi-chat sees
 *    stopReason "aborted", clears the flag, fails the job, and sends nothing.
 *
 * Replies are written straight to the Telegram Bot API with the token pi-chat
 * already stores. Sending only - pi-chat keeps sole ownership of receiving, so
 * there is no getUpdates conflict.
 */

import { readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const AGENT_HOME = join(homedir(), ".pi", "agent");
const AUTH_FILE = join(AGENT_HOME, "auth.json");
const MODELS_FILE = join(AGENT_HOME, "models.json");
const CHAT_CONFIG = join(AGENT_HOME, "chat", "config.json");

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Commands pi-chat consumes itself; never shadow them. */
const RESERVED = new Set(["stop", "new", "compact", "status"]);

/** Commands this extension owns. */
const COMMANDS = new Set([
	"help", "model", "thinking", "login", "logout", "providers", "whichmodel", "endpoint", "cancel",
]);

/** Telegram rejects messages longer than 4096 characters. */
const TELEGRAM_LIMIT = 3900;

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

/** Split a long reply on line boundaries so nothing is silently truncated. */
export function chunk(text: string, limit = TELEGRAM_LIMIT): string[] {
	if (text.length <= limit) return [text];
	const parts: string[] = [];
	let current = "";
	for (const line of text.split("\n")) {
		const candidate = current ? `${current}\n${line}` : line;
		if (candidate.length > limit && current) {
			parts.push(current);
			current = line;
		} else {
			current = candidate;
		}
	}
	if (current) parts.push(current);
	return parts;
}

type Pending =
	| { kind: "model"; items: Array<{ provider: string; id: string }> }
	| { kind: "thinking" }
	| { kind: "login"; providers: string[] }
	| { kind: "apikey"; provider: string }
	| { kind: "endpoint"; step: "name" | "baseUrl" | "modelId" | "apiKey"; draft: EndpointDraft };

interface EndpointDraft {
	name?: string;
	baseUrl?: string;
	modelId?: string;
}

let pending: Pending | undefined;
let pendingAt = 0;

/** Abandon a half-finished picker rather than trapping the chat in it. */
const PENDING_TTL_MS = 5 * 60 * 1000;

/**
 * Is this message an answer to the open prompt? A free-text step (an API key,
 * an endpoint field) takes anything; a numbered picker takes only a number or
 * "cancel". Anything else is ordinary chat and must be left alone.
 */
export function isPendingReply(pending: { kind: string }, text: string): boolean {
	const trimmed = text.trim();
	if (trimmed.toLowerCase() === "cancel") return true;
	if (pending.kind === "apikey" || pending.kind === "endpoint") return true;
	return /^\d+$/.test(trimmed);
}
/** Set when a command was handled, so the resulting turn is aborted. */
let suppressTurn = false;

// ---------------------------------------------------------------- chat wiring

interface ChatTarget {
	token: string;
	chatId: string;
	accountId: string;
	channelKey: string;
}

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

function channelLogPath(target: ChatTarget): string {
	return join(AGENT_HOME, "chat", "accounts", target.accountId, "channels", target.channelKey, "channel.jsonl");
}

/**
 * pi rewrites its process title, so `--chat-conversation` is not visible in
 * /proc and process.argv cannot be trusted alone. Fall back to the only
 * configured Telegram channel, then to the most recently written channel log.
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
			if (joined.includes(conversationId) || joined.some((v) => sanitize(v) === sanitize(conversationId))) {
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
			// no log yet
		}
	}
	return newest;
}

async function send(target: ChatTarget, text: string): Promise<void> {
	for (const part of chunk(text)) {
		try {
			await fetch(`https://api.telegram.org/bot${target.token}/sendMessage`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ chat_id: target.chatId, text: part, disable_web_page_preview: true }),
			});
		} catch {
			// never let a delivery failure break the worker
		}
	}
}

async function deleteLastInbound(target: ChatTarget): Promise<boolean> {
	let messageId: string | undefined;
	try {
		const lines = readFileSync(channelLogPath(target), "utf8").trim().split("\n");
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
		return ((await response.json()) as any)?.ok === true;
	} catch {
		return false;
	}
}

// ------------------------------------------------------------- state on disk

function readJson(path: string): Record<string, any> {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

function writeJson(path: string, value: Record<string, any>, mode: number): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode });
}

/** `key` supports `!command` and `$VAR`, so a literal secret must be escaped. */
export function escapeKey(raw: string): string {
	if (raw.startsWith("$")) return `$$${raw.slice(1)}`;
	if (raw.startsWith("!")) return `$!${raw.slice(1)}`;
	return raw;
}

// -------------------------------------------------------------- prompt parser

/**
 * pi-chat formats each inbound message as
 *   `- [<timestamp>] [uid:<userId>] <userName>: <text>`
 * and batches every message since the last completed job into ONE prompt.
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

// ------------------------------------------------------------------- helpers

function providerState(ctx: any, provider: string): string {
	// A subscription/OAuth provider such as openai-codex has no apiKey, so the
	// registry check alone reports it as unauthenticated even while it is the
	// active model. Presence in auth.json is the authoritative signal.
	try {
		if (Object.prototype.hasOwnProperty.call(readJson(AUTH_FILE), provider)) return "authenticated";
	} catch {
		// fall through to the registry
	}
	try {
		const auth = ctx?.modelRegistry?.getProviderAuth?.(provider);
		return auth?.apiKey || auth?.headers || auth?.baseUrl ? "authenticated" : "not authenticated";
	} catch {
		return "not authenticated";
	}
}

function listModels(ctx: any): Array<{ provider: string; id: string }> {
	try {
		const scoped = Array.isArray(ctx?.scopedModels) ? ctx.scopedModels : [];
		const source =
			scoped.length > 0 ? scoped.map((e: any) => e?.model) : (ctx?.modelRegistry?.getAvailable?.() ?? []);
		if (!Array.isArray(source)) return [];
		return source
			.filter((m: any) => m?.provider && m?.id)
			.map((m: any) => ({ provider: String(m.provider), id: String(m.id) }));
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
	"/model [filter]   - list and switch model",
	"/thinking         - list and set thinking level",
	"/login [filter]   - authenticate a provider with an API key",
	"/endpoint         - add a custom OpenAI-compatible endpoint",
	"/logout <name>    - remove a provider credential",
	"/providers        - show configured providers and auth state",
	"/whichmodel       - show the active model and thinking level",
	"/help             - this message",
	"",
	"Reply with a number to pick from a list. Send 'cancel' to abort.",
	"pi-chat still owns stop, new, compact and status.",
].join("\n");

// ------------------------------------------------------------------ extension

export default function (pi: any) {
	// A handled input would strand pi-chat's chatTurnInFlight flag, so the turn
	// is allowed to start and cancelled here instead. pi-chat reads stopReason
	// "aborted", clears the flag, and delivers nothing to the chat.
	// Abort on turn_start, not agent_start. Aborting before the agent loop is
	// running ends the turn with stopReason "error", and pi-chat reports that to
	// the chat as "pi-chat error: This operation was aborted". Its "aborted"
	// branch is silent, so the cancel has to land once the turn is genuinely in
	// flight.
	pi.on("turn_start", async (_event: any, ctx: any) => {
		if (!suppressTurn) return;
		suppressTurn = false;
		try {
			ctx.abort();
		} catch {
			// if abort is unavailable the model simply answers as usual
		}
	});

	pi.on("input", async (event: any, ctx: any) => {
		if (event?.source !== "extension") return;
		const raw = String(event.text ?? "");
		const latest = lastUserText(raw);
		if (!latest) return;

		const target = resolveTarget();
		if (!target) return;

		// A burst arrives as one batch; act on the newest recognised command.
		const chosen = pending ? latest : (pickCommand(raw, COMMANDS) ?? latest);
		const [rawCommand = "", ...rest] = chosen.split(/\s+/);
		const command = rawCommand.replace(/^\//, "").toLowerCase();
		const argument = rest.join(" ").trim();

		if (RESERVED.has(command)) return;
		if (!pending && !COMMANDS.has(command)) return;

		const reply = async (text: string) => {
			await send(target, text);
			if (ctx?.model) {
				// A model exists, so a turn will start: cancel it in agent_start.
				// pi-chat then sees stopReason "aborted" and clears its flag.
				suppressTurn = true;
				return;
			}
			// With no model configured pi never starts an agent turn, so
			// agent_end never fires and pi-chat's chatTurnInFlight stays true -
			// every later message is then dropped by tryDispatch. Verified on a
			// live worker: queueLength 2, hasActiveJob true, chatTurnInFlight
			// true, model "unknown/unknown".
			//
			// /chat-new is the only reset an extension can reach: it runs
			// ctx.newSession(), whose session_shutdown tears the runtime down and
			// clears the flag, then reconnects the same conversation. pi-chat
			// uses it for its own "new" control command.
			//
			// Deliver it plainly: `deliverAs: "followUp"` queues the message until
			// the agent finishes, and here no agent ever finishes, so the reset was
			// never delivered at all. Defer by a tick so the current input handler
			// returns before the session is replaced.
			setTimeout(() => {
				try {
					pi.sendUserMessage("/chat-new");
				} catch {
					// leave the flag alone rather than crash the worker
				}
			}, 500);
		};

		try {
			if (pending && Date.now() - pendingAt > PENDING_TTL_MS) {
				pending = undefined;
			}

			if (pending && !isPendingReply(pending, chosen)) {
				// Ordinary conversation while a picker is open must reach the
				// model rather than being answered with "reply with a number".
				pending = undefined;
				return;
			}

			if (pending) {
				if (command === "cancel") {
					pending = undefined;
					await reply("Cancelled.");
					return;
				}

				if (pending.kind === "apikey") {
					const provider = pending.provider;
					pending = undefined;
					const auth = readJson(AUTH_FILE);
					auth[provider] = { type: "api_key", key: escapeKey(chosen) };
					writeJson(AUTH_FILE, auth, 0o600);
					const removed = await deleteLastInbound(target);
					await reply(
						[
							`Stored an API key for ${provider}.`,
							removed
								? "Your message with the key was deleted from this chat."
								: "Could not delete your message automatically - please delete it yourself.",
							"The key is also recorded in this channel's local pi-chat log.",
							"",
							"Run /model to pick a model.",
						].join("\n"),
					);
					return;
				}

				if (pending.kind === "endpoint") {
					const step = pending.step;
					const draft = pending.draft;
					if (step === "name") {
						const name = sanitize(chosen).toLowerCase();
						if (!name) {
							await reply("That name is not usable. Send a short name such as my-openai.");
							return;
						}
						pending = { kind: "endpoint", step: "baseUrl", draft: { ...draft, name } };
						pendingAt = Date.now();
						await reply(
							`Name: ${name}\n\nSend the base URL, for example https://api.example.com/v1`,
						);
						return;
					}
					if (step === "baseUrl") {
						if (!/^https?:\/\//i.test(chosen)) {
							await reply("That does not look like a URL. Send something starting with https://");
							return;
						}
						pending = { kind: "endpoint", step: "modelId", draft: { ...draft, baseUrl: chosen } };
						pendingAt = Date.now();
						await reply("Send the model id exposed by that endpoint, for example gpt-4o.");
						return;
					}
					if (step === "modelId") {
						pending = { kind: "endpoint", step: "apiKey", draft: { ...draft, modelId: chosen } };
						pendingAt = Date.now();
						await reply(
							[
								"Send the API key for this endpoint.",
								"",
								"Warning: the key passes through Telegram and is written to this",
								"channel's local chat log. Send 'none' if the endpoint ignores keys.",
							].join("\n"),
						);
						return;
					}
					// apiKey step
					const { name, baseUrl, modelId } = draft;
					pending = undefined;
					const models = readJson(MODELS_FILE);
					const providers = (models.providers ??= {});
					providers[name as string] = {
						baseUrl,
						api: "openai-completions",
						apiKey: chosen.toLowerCase() === "none" ? "unused" : escapeKey(chosen),
						models: [{ id: modelId }],
					};
					writeJson(MODELS_FILE, models, 0o600);
					await deleteLastInbound(target);
					await reply(
						[
							`Added endpoint "${name}".`,
							`  base URL: ${baseUrl}`,
							`  model:    ${modelId}`,
							"  api:      openai-completions",
							"",
							"models.json is read when a worker starts, so this endpoint appears",
							"after the workers are restarted with /chat-spawn-all --restart in",
							"pi's terminal session. Then run /model and pick it.",
						].join("\n"),
					);
					return;
				}

				const choice = Number.parseInt(chosen, 10);
				if (!Number.isFinite(choice)) {
					await reply("Reply with a number from the list, or 'cancel'.");
					return;
				}

				if (pending.kind === "model") {
					const picked = pending.items[choice - 1];
					pending = undefined;
					if (!picked) {
						await reply("That number is not on the list.");
						return;
					}
					const model = ctx?.modelRegistry?.find?.(picked.provider, picked.id);
					if (!model) {
						await reply(`Model ${picked.provider}/${picked.id} is no longer available.`);
						return;
					}
					const ok = await pi.setModel(model);
					await reply(
						ok
							? `Model set to ${picked.provider}/${picked.id}.`
							: `No credentials configured for ${picked.provider}. Run /login first.`,
					);
					return;
				}

				if (pending.kind === "thinking") {
					const level = THINKING_LEVELS[choice - 1];
					pending = undefined;
					if (!level) {
						await reply("That number is not on the list.");
						return;
					}
					pi.setThinkingLevel(level);
					await reply(`Thinking level set to ${level}.`);
					return;
				}

				if (pending.kind === "login") {
					const provider = pending.providers[choice - 1];
					if (!provider) {
						pending = undefined;
						await reply("That number is not on the list.");
						return;
					}
					pending = { kind: "apikey", provider };
					pendingAt = Date.now();
					await reply(
						[
							`Send the API key for ${provider} as your next message.`,
							"",
							"Warning: the key passes through Telegram and is written to this",
							"channel's local chat log. This extension deletes your message when it",
							"can. For the strongest handling use /login in pi's terminal session.",
							"",
							"Send 'cancel' to abort.",
						].join("\n"),
					);
					return;
				}
			}

			switch (command) {
				case "help":
					await reply(HELP);
					return;

				case "whichmodel": {
					const model = ctx?.model;
					await reply(
						model
							? `Model: ${model.provider}/${model.id}\nThinking: ${ctx?.thinkingLevel ?? "unknown"}`
							: "No model is active. Run /login, then /model.",
					);
					return;
				}

				case "providers": {
					const catalogue = [...new Set(listModels(ctx).map((e) => e.provider))];
					const stored = Object.keys(readJson(AUTH_FILE));
					const custom = Object.keys(readJson(MODELS_FILE).providers ?? {});
					const rows = knownProviders([...catalogue, ...custom])
						.filter((e) => stored.includes(e.key) || catalogue.includes(e.key) || custom.includes(e.key))
						.map((e) => `- ${e.label} (${e.key}): ${providerState(ctx, e.key)}`);
					await reply(
						rows.length
							? `Configured providers:\n${rows.join("\n")}`
							: "No provider is configured yet. Run /login to add one.",
					);
					return;
				}

				case "model": {
					let models = listModels(ctx);
					if (argument) {
						const needle = argument.toLowerCase();
						models = models.filter((e) => `${e.provider}/${e.id}`.toLowerCase().includes(needle));
					}
					if (models.length === 0) {
						await reply(
							argument
								? `No model matches "${argument}".`
								: "No models are available yet. Authenticate a provider with /login first.",
						);
						return;
					}
					pending = { kind: "model", items: models };
					pendingAt = Date.now();
					const active = ctx?.model ? `\n\nActive: ${ctx.model.provider}/${ctx.model.id}` : "";
					await reply(
						`Select a model:\n${numbered(models.map((e) => `${e.provider}/${e.id}`))}${active}`,
					);
					return;
				}

				case "thinking": {
					pending = { kind: "thinking" };
					pendingAt = Date.now();
					await reply(
						`Select a thinking level:\n${numbered([...THINKING_LEVELS])}\n\nActive: ${ctx?.thinkingLevel ?? "unknown"}`,
					);
					return;
				}

				case "login": {
					const catalogue = [...new Set(listModels(ctx).map((e) => e.provider))];
					const custom = Object.keys(readJson(MODELS_FILE).providers ?? {});
					let providers = knownProviders([...catalogue, ...custom]);
					if (argument) {
						const needle = argument.toLowerCase();
						providers = providers.filter(
							(e) => e.key.toLowerCase().includes(needle) || e.label.toLowerCase().includes(needle),
						);
					}
					if (providers.length === 0) {
						await reply(`No provider matches "${argument}".`);
						return;
					}
					pending = { kind: "login", providers: providers.map((e) => e.key) };
					pendingAt = Date.now();
					await reply(
						[
							"Select a provider to authenticate with an API key:",
							numbered(providers.map((e) => `${e.label} (${providerState(ctx, e.key)})`)),
							"",
							"/endpoint adds a custom OpenAI-compatible URL.",
							"Subscription and OAuth sign-in need pi's terminal session.",
						].join("\n"),
					);
					return;
				}

				case "endpoint": {
					pending = { kind: "endpoint", step: "name", draft: {} };
					pendingAt = Date.now();
					await reply(
						[
							"Add a custom OpenAI-compatible endpoint.",
							"",
							"Send a short name for it, for example my-openai or vllm.",
							"Send 'cancel' to abort.",
						].join("\n"),
					);
					return;
				}

				case "logout": {
					if (!argument) {
						await reply("Usage: /logout <provider>");
						return;
					}
					const auth = readJson(AUTH_FILE);
					if (!(argument in auth)) {
						await reply(`No stored credential for ${argument}.`);
						return;
					}
					delete auth[argument];
					writeJson(AUTH_FILE, auth, 0o600);
					await reply(`Removed the stored credential for ${argument}.`);
					return;
				}

				case "cancel":
					await reply("Nothing to cancel.");
					return;

				default:
					return;
			}
		} catch (error: any) {
			// pi swallows errors thrown by an input handler, which would leave the
			// user staring at silence. Surface it in the chat instead.
			pending = undefined;
			await reply(`pi-model-telegram failed: ${error?.message ?? String(error)}`);
		}
	});
}
