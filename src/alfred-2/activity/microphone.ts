import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export const MICROPHONE_PROBE_TIMEOUT_MS = 5_000;

export type MicrophoneState = "active" | "inactive" | "unknown";

export interface MicrophoneProbeResult {
	state: MicrophoneState;
	evidence: string[];
	sampledAt: string;
	error?: string;
}

interface ParsedMicrophoneState {
	state: Exclude<MicrophoneState, "unknown">;
	evidence: string[];
}

export async function probeMacMicrophoneState(now = new Date()): Promise<MicrophoneProbeResult> {
	try {
		const { stdout } = await execFileAsync("/usr/sbin/ioreg", ["-r", "-c", "IOAudioEngine", "-d", "2"], {
			timeout: MICROPHONE_PROBE_TIMEOUT_MS,
			maxBuffer: 2 * 1024 * 1024,
		});
		const parsed = parseMacAudioEngineMicrophoneState(stdout);
		if (!parsed) {
			return { state: "unknown", evidence: ["no parseable input audio engine state"], sampledAt: now.toISOString(), error: "malformed_ioreg_audio_output" };
		}
		return { ...parsed, sampledAt: now.toISOString() };
	} catch (error) {
		return {
			state: "unknown",
			evidence: ["microphone probe failed"],
			sampledAt: now.toISOString(),
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export function parseMacAudioEngineMicrophoneState(output: string): ParsedMicrophoneState | null {
	const blocks = splitIoregObjectBlocks(output);
	const inputBlocks = blocks.filter((block) => isInputAudioEngineBlock(block));
	if (inputBlocks.length === 0) return null;
	const activeEvidence: string[] = [];
	const inactiveEvidence: string[] = [];
	for (const block of inputBlocks) {
		const state = parseAudioEngineState(block);
		const name = parseIoregObjectName(block) ?? "input audio engine";
		if (state === null) continue;
		if (state > 0) activeEvidence.push(`${name} state=${state}`);
		else inactiveEvidence.push(`${name} state=${state}`);
	}
	if (activeEvidence.length > 0) return { state: "active", evidence: activeEvidence };
	if (inactiveEvidence.length > 0) return { state: "inactive", evidence: inactiveEvidence };
	return null;
}

function splitIoregObjectBlocks(output: string): string[] {
	const lines = output.split(/\r?\n/);
	const blocks: string[] = [];
	let current: string[] = [];
	for (const line of lines) {
		if (/^\s*[+|\\-]*\s*\+-o\s+/.test(line) && current.length > 0) {
			blocks.push(current.join("\n"));
			current = [];
		}
		current.push(line);
	}
	if (current.some((line) => line.trim())) blocks.push(current.join("\n"));
	return blocks;
}

function isInputAudioEngineBlock(block: string): boolean {
	return /"IOAudioEngineDirection"\s*=\s*(?:"Input"|1)\b/i.test(block)
		|| /"IOAudioEngineInput"\s*=\s*Yes\b/i.test(block)
		|| /Input/i.test(parseIoregObjectName(block) ?? "");
}

function parseAudioEngineState(block: string): number | null {
	const match = block.match(/"IOAudioEngineState"\s*=\s*(\d+)/);
	if (!match) return null;
	const state = Number(match[1]);
	return Number.isFinite(state) && state >= 0 ? state : null;
}

function parseIoregObjectName(block: string): string | null {
	const match = block.match(/\+-o\s+([^<\n]+)</);
	return match?.[1]?.trim() ?? null;
}
