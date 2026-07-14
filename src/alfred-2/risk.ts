import type { AlfredToolCall, ToolRiskLevel, ConfirmationRequirement } from "./tool-types.ts";

export interface RiskClassification {
	risk: ToolRiskLevel;
	confirmation: ConfirmationRequirement;
	blockedReason?: string;
}

// ── Read-only no-confirmation commands (operational-decisions.md) ──
const READ_ONLY_GIT_PATTERNS = [
	/\bgit\s+status\b/,
	/\bgit\s+diff\b/,
	/\bgit\s+log\b/,
	/\bgh\s+pr\s+view\b/,
];

const READ_ONLY_DIAGNOSTIC_PATTERNS = [
	/\bnpm\s+(test|run\s+lint|run\s+typecheck|outdated|audit)\b/,
	/\bpytest\b/,
	/\bruff\b/,
	/\btsc\b/,
	/\bnpx\s+tsc\b/,
];

// ── Mutation requiring confirmation ──
const GIT_MUTATION_PATTERNS = [
	/\bgit\s+add\b/,
	/\bgit\s+commit\b/,
	/\bgit\s+stash\b/,
	/\bgit\s+checkout\b/,
	/\bgit\s+pull\b/,
	/\bgit\s+merge\b/,
];

const PACKAGE_MUTATION_PATTERNS = [
	/\bnpm\s+(install|uninstall|audit\s+fix)\b/,
	/\bpip\s+install\b/,
	/\bbrew\s+install\b/,
];

// ── Destructive requiring explicit confirmation ──
const DESTRUCTIVE_GIT_PATTERNS = [
	/\bgit\s+push\b/,
	/\bgit\s+reset\s+--hard\b/,
	/\bgit\s+clean\b/,
	/\bpush\s+--force\b/,
	/\b--force-with-lease\b/,
	/\bbranch\s+-D\b/,
];

const DESTRUCTIVE_BASH_PATTERNS = [
	/\brm\b/,
	/\bsudo\b/,
	/\bkill\b/,
	/\bshutdown\b/,
	/\breboot\b/,
	/\bdd\s+if=/,
	/\bcurl\b.*\|\s*(?:sh|bash|python)/,
	/\bwget\b.*\|\s*(?:sh|bash|python)/,
	/>\s*\/dev\/(?!null\b)/,
	/\bchmod\b/,
	/\bchown\b/,
];

const GENERAL_MUTATION_BASH_PATTERNS = [
	/\bmv\b/,
	/\bcp\b/,
	/\bmkdir\b/,
	/>>\s*(?!\/dev\/null\b)\S+/,
	/(?:^|[^\d])>\s*(?!\/dev\/null\b)\S+/,
	/\b\d>\s*(?!&1\b|\/dev\/null\b)\S+/,
	/\btee\s+(?!-a\s+|\/dev\/null\b)\S+/,
];

// ── Hard-blocked paths ──
const BLOCKED_PATH_PREFIXES = [
	/^\/etc\//,
	/^\/etc$/,
	/^\/boot\//,
	/^\/boot$/,
	/^\/sys\//,
	/^\/sys$/,
	/^\/proc\//,
	/^\/proc$/,
	/^\/dev\//,
	/^\/dev$/,
];

const BLOCKED_PATH_PATTERNS = [
	/\.ssh\//,
	/\/\.ssh\//,
	/\.ssh$/,
	/\/authorized_keys$/,
	/\/known_hosts$/,
	/\/id_rsa/,
	/\/id_ed25519/,
	/\/id_ecdsa/,
	/\/\.aws\/credentials/,
	/\/\.env$/,
];

/**
 * Centralized risk classifier for every Alfred tool call.
 * Rules derived from operational-decisions.md.
 */
export function classifyToolRisk(toolCall: AlfredToolCall): RiskClassification {
	switch (toolCall.tool) {
		case "bash":
			return classifyBashRisk(toolCall);
		case "read_file":
			return classifyReadFileRisk(toolCall);
		case "write_file":
			return classifyWriteFileRisk(toolCall);
		case "edit_file":
			return classifyEditFileRisk(toolCall);
		case "web_search":
			return { risk: "external", confirmation: "none" };
		case "fetch_content":
			return { risk: "external", confirmation: "none" };

		case "remember":
			return { risk: "mutation", confirmation: "none" };
		case "recall":
			return { risk: "read", confirmation: "none" };
		case "set_voice_settings":
			return { risk: "mutation", confirmation: "none" };
		case "refresh_context":
			return { risk: "read", confirmation: "none" };
		case "inspect_session":
			return { risk: "read", confirmation: "none" };
		case "send_session_message":
			return { risk: "mutation", confirmation: "confirm" };
		case "start_session_monitor":
			return toolCall.replyMode === "send" ? { risk: "destructive", confirmation: "explicit" } : { risk: "mutation", confirmation: "confirm" };
		case "poll_session_monitor":
		case "session_monitor_status":
			return { risk: "read", confirmation: "none" };
		case "stop_session_monitor":
			return { risk: "mutation", confirmation: "none" };
		case "gmail_search":
		case "gmail_read":
		case "calendar_today":
		case "calendar_upcoming":
		case "docs_search":
		case "docs_read":
			return { risk: "external", confirmation: "none" };
		case "log_break":
			return { risk: "mutation", confirmation: "none" };
		case "wellness_status":
			return { risk: "read", confirmation: "none" };
	}
}

function classifyBashRisk(toolCall: { tool: "bash"; command: string; cwd?: string; path?: string }): RiskClassification {
	const command = toolCall.command;

	// Check for hard-blocked paths in the command
	const pathBlock = checkBlockedPaths(toolCall);
	if (pathBlock) return pathBlock;

	// Destructive patterns first (takes priority over mutation)
	if (DESTRUCTIVE_GIT_PATTERNS.some((p) => p.test(command)) || DESTRUCTIVE_BASH_PATTERNS.some((p) => p.test(command))) {
		return { risk: "destructive", confirmation: "explicit" };
	}

	// Git mutations
	if (GIT_MUTATION_PATTERNS.some((p) => p.test(command))) {
		return { risk: "mutation", confirmation: "confirm" };
	}

	// Package mutations
	if (PACKAGE_MUTATION_PATTERNS.some((p) => p.test(command))) {
		return { risk: "mutation", confirmation: "confirm" };
	}

	// General mutation patterns (mv, cp, mkdir, redirects)
	if (GENERAL_MUTATION_BASH_PATTERNS.some((p) => p.test(command))) {
		return { risk: "mutation", confirmation: "confirm" };
	}

	// Read-only diagnostics — no confirmation
	if (READ_ONLY_GIT_PATTERNS.some((p) => p.test(command)) || READ_ONLY_DIAGNOSTIC_PATTERNS.some((p) => p.test(command))) {
		return { risk: "read", confirmation: "none" };
	}

	// Default: read (e.g. echo, ls, pwd, grep, cat)
	return { risk: "read", confirmation: "none" };
}

function classifyReadFileRisk(toolCall: { tool: string; path: string }): RiskClassification {
	const pathBlock = checkBlockedPaths(toolCall);
	if (pathBlock) return pathBlock;
	return { risk: "read", confirmation: "none" };
}

function classifyWriteFileRisk(toolCall: { tool: string; path: string }): RiskClassification {
	const pathBlock = checkBlockedPaths(toolCall);
	if (pathBlock) return pathBlock;
	// write_file always overwrites — confirmation required
	return { risk: "mutation", confirmation: "confirm" };
}

function classifyEditFileRisk(toolCall: { tool: string; path: string }): RiskClassification {
	const pathBlock = checkBlockedPaths(toolCall);
	if (pathBlock) return pathBlock;
	// All edit_file calls require confirmation
	return { risk: "mutation", confirmation: "confirm" };
}

function checkBlockedPaths(toolCall: { cwd?: string; path?: string; command?: string }): RiskClassification | null {
	// Check path field directly (for file tools)
	if ("path" in toolCall && typeof toolCall.path === "string") {
		const path = toolCall.path;
		if (BLOCKED_PATH_PREFIXES.some((p) => p.test(path))) {
			return { risk: "destructive", confirmation: "blocked", blockedReason: `Path ${path} is a protected system location.` };
		}
		if (BLOCKED_PATH_PATTERNS.some((p) => p.test(path))) {
			return { risk: "destructive", confirmation: "blocked", blockedReason: `Path ${path} is a protected security-sensitive location.` };
		}
	}

	// Check bash command for blocked paths
	if ("command" in toolCall && typeof toolCall.command === "string") {
		const command = toolCall.command;
		for (const pattern of BLOCKED_PATH_PATTERNS) {
			if (pattern.test(command)) {
				return { risk: "destructive", confirmation: "blocked", blockedReason: `Command references a protected security-sensitive path.` };
			}
		}
	}

	return null;
}

/**
 * Returns true when the bash command is classified as destructive
 * by the same rules used in classifyBashRisk.
 */
export function isDestructiveBash(command: string): boolean {
	// Hard-blocked paths are also considered destructive for display purposes
	if (BLOCKED_PATH_PATTERNS.some((p) => p.test(command))) return true;
	if (DESTRUCTIVE_GIT_PATTERNS.some((p) => p.test(command))) return true;
	if (DESTRUCTIVE_BASH_PATTERNS.some((p) => p.test(command))) return true;
	return false;
}

/**
 * Returns true when the bash command is a git mutation (including destructive git).
 */
export function isGitMutation(command: string): boolean {
	if (GIT_MUTATION_PATTERNS.some((p) => p.test(command))) return true;
	if (DESTRUCTIVE_GIT_PATTERNS.some((p) => p.test(command))) return true;
	return false;
}

/**
 * Returns true when the bash command is a package manager mutation.
 */
export function isPackageMutation(command: string): boolean {
	return PACKAGE_MUTATION_PATTERNS.some((p) => p.test(command));
}
