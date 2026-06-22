import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

export interface CopyTokenCliOptions {
	readonly envFile?: string;
	readonly stdout?: Pick<NodeJS.WriteStream, "write">;
	readonly stderr?: Pick<NodeJS.WriteStream, "write">;
	readonly writeClipboard?: (value: string) => Promise<void>;
}

export function parseAlfredLocalTokenEnv(content: string): string | null {
	for (const rawLine of content.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const match = line.match(/^(?:export\s+)?ALFRED_LOCAL_TOKEN\s*=\s*(.*)$/);
		if (!match) continue;
		return parseEnvValue(match[1] ?? "");
	}
	return null;
}

export async function runCopyTokenCli(options: CopyTokenCliOptions = {}): Promise<number> {
	const stdout = options.stdout ?? process.stdout;
	const stderr = options.stderr ?? process.stderr;
	const envFile = options.envFile ?? `${homedir()}/.alfred/daemon.env`;
	let content: string;
	try {
		content = await readFile(envFile, "utf8");
	} catch (error) {
		stderr.write(`Could not read ${envFile}. Configure a stable token first.\n`);
		stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}

	const token = parseAlfredLocalTokenEnv(content);
	if (!token) {
		stderr.write(`No ALFRED_LOCAL_TOKEN found in ${envFile}.\n`);
		return 1;
	}

	try {
		await (options.writeClipboard ?? writeMacClipboard)(token);
	} catch (error) {
		stderr.write(`Could not copy Alfred token to clipboard: ${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}

	stdout.write("Alfred local token copied to clipboard. Paste it into the dashboard token field and Save locally.\n");
	return 0;
}

function parseEnvValue(raw: string): string {
	const withoutComment = stripUnquotedComment(raw).trim();
	if ((withoutComment.startsWith('"') && withoutComment.endsWith('"')) || (withoutComment.startsWith("'") && withoutComment.endsWith("'"))) {
		return withoutComment.slice(1, -1);
	}
	return withoutComment;
}

function stripUnquotedComment(value: string): string {
	let quote: string | null = null;
	for (let index = 0; index < value.length; index += 1) {
		const char = value[index];
		if ((char === '"' || char === "'") && value[index - 1] !== "\\") {
			quote = quote === char ? null : quote ?? char;
		}
		if (char === "#" && !quote) {
			return value.slice(0, index);
		}
	}
	return value;
}

async function writeMacClipboard(value: string): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const child = spawn("pbcopy", [], { stdio: ["pipe", "ignore", "pipe"] });
		let stderr = "";
		child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
		child.on("error", reject);
		child.on("close", (code) => {
			code === 0 ? resolve() : reject(new Error(stderr.trim() || `pbcopy exited with ${code}`));
		});
		child.stdin.end(value);
	});
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	process.exitCode = await runCopyTokenCli();
}
