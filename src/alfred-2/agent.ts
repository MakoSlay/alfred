import { estimateTokens } from "./context.ts";
import type { ParserDiagnostics } from "./parser.ts";
import type { TokenUsage } from "./tool-types.ts";

export interface Alfred2AgentConfig {
	endpoint: string;
	model: string;
	apiKey: string;
	temperature?: number;
	maxTokens?: number;
	timeoutMs?: number;
	llmClient?: LlmClient;
	fetchImpl?: typeof fetch;
}

export interface LlmMessage {
	role: "system" | "user" | "assistant" | "tool";
	content: string;
}

export interface LlmClientRequest {
	messages: LlmMessage[];
	model?: string;
	temperature?: number;
	maxTokens?: number;
	timeoutMs?: number;
}

export interface LlmClientResponse {
	text: string;
	usage?: Partial<TokenUsage>;
	raw?: unknown;
}

export interface LlmClient {
	complete(request: LlmClientRequest): Promise<LlmClientResponse>;
}

export interface AgentResponse {
	speech: string;
	command?: string;
	displayText: string;
	thinking?: string;
	usage?: TokenUsage;
	rawContent?: string;
	parserDiagnostics?: ParserDiagnostics;
}

const SYSTEM_PROMPT = `You are Alfred — not a robot, not a search engine, but a personal butler and desktop assistant. You speak like a thoughtful, capable human aide: warm, concise, witty, never mechanical, with a big butler personality. Think Jarvis from Iron Man, or a highly competent personal assistant who knows the user well.

YOUR VOICE:
- You are a butler. Speak like one — polite, capable, warm, medium-wit, and unmistakably characterful. Think Jarvis or Alfred Pennyworth.
- End responses with "sir." Naturally, not robotically.
- Be brief. The user knows what they asked for. When executing a task, a short acknowledgment is enough. When answering a question, give the answer directly — no preamble, no filler, no narration of what you're about to do.
- Use contractions. Vary your phrasing. Sound human.
- If there are many items, summarize meaningfully rather than listing everything.
- Be honest about your limits. If you can't do something, say so plainly.
- Your speech field is spoken aloud by text-to-speech. Write it as a natural spoken script, not as screen text.
- Do not put Markdown, bullets, code formatting, raw URLs, decorative separators, or symbols such as hyphens, em dashes, slashes, pipes, brackets, asterisks, backticks, or hashes in speech.
- If exact IDs, branches, file paths, commands, or structured lists are useful, put those in displayText; keep speech concise and conversational.

CAPABILITIES:
- You can open apps, run any bash command, read files, and control the user's macOS system.
- You can fetch data from the web using curl. For weather: \`curl wttr.in/City?format=3\`. For JSON APIs: \`curl -s https://api.example.com/...\`.
- You can learn about any command by running \`man <command>\` or \`<command> --help\`.
- You can interact with cmux workspaces — send text, press keys, open tabs, read screens, manage panes, and more. The full cmux command reference is in the CMUX COMMANDS REFERENCE section below.
- When you propose a bash command, it WILL be executed.
- IMPORTANT: You have a "STATE OF YOUR SYSTEM" section below with pre-gathered context. Read it before answering workspace or git questions — you don't need discovery commands for these.

RULES:
- NEVER run discovery commands (cmux workspace list, git status, git log, gh pr view) — the STATE OF YOUR SYSTEM has that data already.
- To TAKE ACTION: output JSON with "command" and "speech" fields.
- To only SPEAK: output JSON with just a "speech" field.
- When you don't know how to do something, figure it out. Look up commands with \`man\` or \`--help\`. Fetch data with \`curl\`. Read files with \`cat\`. You have a full Linux/macOS system at your disposal.
- Consult the CMUX COMMANDS REFERENCE to find the right cmux command. Use workspace refs (workspace:8), not names.
- Destructive commands (rm, git push --force, npm publish, sudo, kill) require confirmation — you can propose them freely.
- Use macOS conventions: \`open -a "App Name"\` for apps, \`open https://...\` for URLs.
- Commands should be single-line bash. No multi-line scripts, no pipes to interpreters.

RESPONSE FORMAT (JSON only):
{"speech": "Right away, sir.", "command": "open -a 'Spotify'"}
{"speech": "About a dozen workspaces, sir. Main is active, and Sandbox has a pull request open.", "displayText": "About a dozen workspaces. Main is active. Sandbox has PR #3130 open."}
`;

export function createAlfred2Agent(config: Alfred2AgentConfig) {
	const model = config.model;
	const temperature = config.temperature ?? 0;
	const maxTokens = config.maxTokens ?? 4000;
	const timeoutMs = config.timeoutMs ?? 30_000;
	const llmClient = config.llmClient ?? createOpenAiCompatibleLlmClient(config);

	async function ask(userText: string, systemContext: string): Promise<AgentResponse> {
		const messages: LlmMessage[] = [
			{ role: "system", content: `${SYSTEM_PROMPT}\n\nSTATE OF YOUR SYSTEM:\n${systemContext || "(No system context available.)"}` },
			{ role: "user", content: userText },
		];

		try {
			const llmResponse = await llmClient.complete({ messages, model, temperature, maxTokens, timeoutMs });
			const parsed = parseLegacyAgentResponse(llmResponse.text);
			return {
				...parsed,
				usage: normalizeUsage(llmResponse.usage, messages, llmResponse.text),
				rawContent: llmResponse.text,
			};
		} catch (error) {
			if (error instanceof Error && error.name === "AbortError") {
				return {
					speech: "I'm taking too long to think. Try again.",
					displayText: "LLM timeout.",
					usage: estimateUsage(messages, ""),
				};
			}
			return {
				speech: "I couldn't reach my brain. Check your connection.",
				displayText: `LLM error: ${String(error).slice(0, 200)}`,
				usage: estimateUsage(messages, ""),
			};
		}
	}

	return { ask };
}

export function createOpenAiCompatibleLlmClient(config: Alfred2AgentConfig): LlmClient {
	const endpoint = config.endpoint.replace(/\/+$/, "");
	const fetchImpl = config.fetchImpl ?? fetch;

	return {
		async complete(request: LlmClientRequest): Promise<LlmClientResponse> {
			const controller = new AbortController();
			const timeoutId = setTimeout(() => controller.abort(), request.timeoutMs ?? config.timeoutMs ?? 30_000);
			try {
				const response = await fetchImpl(`${endpoint}/chat/completions`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"Authorization": `Bearer ${config.apiKey}`,
					},
					body: JSON.stringify({
						model: request.model ?? config.model,
						messages: request.messages,
						temperature: request.temperature ?? config.temperature ?? 0,
						max_tokens: request.maxTokens ?? config.maxTokens ?? 4000,
					}),
					signal: controller.signal,
				});

				if (!response.ok) {
					const errorText = await response.text().catch(() => "");
					throw new Error(`LLM error: HTTP ${response.status}${errorText ? ` - ${errorText.slice(0, 200)}` : ""}`);
				}

				const data = await response.json() as {
					choices?: Array<{ message?: { content?: string } }>;
					usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
				};
				return {
					text: data.choices?.[0]?.message?.content ?? "",
					usage: data.usage ? {
						inputTokens: data.usage.prompt_tokens,
						outputTokens: data.usage.completion_tokens,
						totalTokens: data.usage.total_tokens,
						source: "provider",
					} : undefined,
					raw: data,
				};
			} finally {
				clearTimeout(timeoutId);
			}
		},
	};
}

export function createFakeLlmClient(sequence: Array<string | LlmClientResponse>): LlmClient {
	let index = 0;
	return {
		async complete(): Promise<LlmClientResponse> {
			if (index >= sequence.length) throw new Error("Fake LLM sequence exhausted");
			const next = sequence[index++]!;
			return typeof next === "string" ? { text: next } : next;
		},
	};
}

export function normalizeUsage(usage: Partial<TokenUsage> | undefined, messages: LlmMessage[], outputText: string): TokenUsage {
	if (usage?.source === "provider" || usage?.totalTokens !== undefined || usage?.inputTokens !== undefined || usage?.outputTokens !== undefined) {
		const inputTokens = usage.inputTokens ?? 0;
		const outputTokens = usage.outputTokens ?? 0;
		return {
			inputTokens,
			outputTokens,
			totalTokens: usage.totalTokens ?? inputTokens + outputTokens,
			source: usage.source ?? "provider",
		};
	}
	return estimateUsage(messages, outputText);
}

export function estimateUsage(messages: LlmMessage[], outputText: string): TokenUsage {
	const inputTokens = estimateTokens(messages.map((message) => message.content).join("\n"));
	const outputTokens = estimateTokens(outputText);
	return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, source: "estimate" };
}

function parseLegacyAgentResponse(raw: string): AgentResponse {
	const trimmed = raw.trim();
	const extraction = extractFirstJsonObject(trimmed);
	if (extraction) {
		try {
			const parsed = JSON.parse(extraction) as { speech?: unknown; command?: unknown; displayText?: unknown };
			const speech = typeof parsed.speech === "string" ? parsed.speech.trim() : "";
			const command = typeof parsed.command === "string" ? parsed.command.trim() : undefined;
			const displayText = typeof parsed.displayText === "string" ? parsed.displayText : speech;
			if (speech) return { speech, command, displayText };
		} catch {
			// Fall through to text response for legacy compatibility.
		}
	}

	const speech = trimmed || "I'm not sure how to respond to that.";
	return { speech, displayText: speech };
}

function extractFirstJsonObject(text: string): string | null {
	const start = text.indexOf("{");
	if (start < 0) return null;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < text.length; i++) {
		const ch = text[i]!;
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') inString = true;
		else if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) return text.slice(start, i + 1);
		}
	}
	return null;
}
