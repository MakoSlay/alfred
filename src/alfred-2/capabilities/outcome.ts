import { STRUCTURED_FAILURE_CONTRACT_VERSION, type FailureCode, type StructuredFailure } from "./failure-codes.ts";
import { TASK_OUTCOME_CONTRACT_VERSION, type FailureStage, type TaskOutcomeStatus } from "./types.ts";

const MAX_FAILURE_MESSAGE_CHARS = 1_000;

export interface TaskOutcome {
	contractVersion: typeof TASK_OUTCOME_CONTRACT_VERSION;
	requestId: string;
	turnId?: string;
	sessionId: string;
	status: TaskOutcomeStatus;
	completedOperationKeys: string[];
	requiredOperationKeys: string[];
	operationLineageKeys: string[];
	terminalFailure?: StructuredFailure;
	startedAt: string;
	endedAt: string;
}

export interface StructuredFailureInput {
	stage: FailureStage;
	code: FailureCode;
	component: string;
	message: string;
	retryable: boolean;
	timedOut?: boolean;
	rateLimited?: boolean;
	httpStatus?: number;
	configKeysMissing?: string[];
	detector?: { id: string; version: number };
}

export function createStructuredFailure(input: StructuredFailureInput): StructuredFailure {
	return Object.freeze({
		...input,
		contractVersion: STRUCTURED_FAILURE_CONTRACT_VERSION,
		message: boundAndRedactFailureMessage(input.message),
		configKeysMissing: input.configKeysMissing ? [...input.configKeysMissing] : undefined,
		detector: input.detector ?? { id: "alfred.typed", version: 1 },
	});
}

export function boundAndRedactFailureMessage(message: string): string {
	return message
		.replace(/(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/-]+=*/gi, (match) => `${match.split(/\s+/)[0]} [REDACTED_CREDENTIAL]`)
		.replace(/\b[A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD)\s*=\s*[^\s]+/gi, (match) => `${match.slice(0, match.indexOf("="))}=[REDACTED]`)
		.replace(/(["']?(?:apiKey|api_key|accessToken|access_token|refreshToken|refresh_token|secret|password)["']?\s*:\s*)["'][^"']*["']/gi, "$1\"[REDACTED]\"")
		.replace(/([?&](?:api_key|apikey|access_token|token|key)=)[^&#\s]*/gi, "$1[REDACTED]")
		.replace(/\b(?:sk-|ghp_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{12,}\b/g, "[REDACTED_SECRET]")
		.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]")
		.slice(0, MAX_FAILURE_MESSAGE_CHARS);
}

export interface TaskOutcomeFinalizerOptions {
	requestId: string;
	turnId?: string;
	sessionId: string;
	startedAt?: Date | string;
	now?: () => Date;
	onFinalize?: (outcome: TaskOutcome) => void;
}

export interface TaskOutcomeFinalizer {
	readonly outcome: TaskOutcome | undefined;
	finalize(input: { status: TaskOutcomeStatus; terminalFailure?: StructuredFailure; completedOperationKeys?: string[]; requiredOperationKeys?: string[]; operationLineageKeys?: string[] }): TaskOutcome;
	complete(): TaskOutcome;
	fail(failure: StructuredFailure): TaskOutcome;
}

export function createTaskOutcomeFinalizer(options: TaskOutcomeFinalizerOptions): TaskOutcomeFinalizer {
	const now = options.now ?? (() => new Date());
	const startedAt = typeof options.startedAt === "string"
		? options.startedAt
		: (options.startedAt ?? now()).toISOString();
	let finalized: TaskOutcome | undefined;

	const api: TaskOutcomeFinalizer = {
		get outcome() { return finalized; },
		finalize(input) {
			if (finalized) return finalized;
			const outcome: TaskOutcome = {
				contractVersion: TASK_OUTCOME_CONTRACT_VERSION,
				requestId: options.requestId,
				turnId: options.turnId,
				sessionId: options.sessionId,
				status: input.status,
				completedOperationKeys: Object.freeze([...(input.completedOperationKeys ?? [])]) as unknown as string[],
				requiredOperationKeys: Object.freeze([...(input.requiredOperationKeys ?? [])]) as unknown as string[],
				operationLineageKeys: Object.freeze([...(input.operationLineageKeys ?? [])]) as unknown as string[],
				terminalFailure: input.terminalFailure ? createStructuredFailure(input.terminalFailure) : undefined,
				startedAt,
				endedAt: now().toISOString(),
			};
			finalized = Object.freeze(outcome);
			try {
				options.onFinalize?.(finalized);
			} catch {
				// Outcome observation must never break the request being finalized.
			}
			return finalized;
		},
		complete() { return api.finalize({ status: "completed" }); },
		fail(failure) { return api.finalize({ status: "failed", terminalFailure: failure }); },
	};
	return api;
}

export function createTaskOutcome(input: TaskOutcomeFinalizerOptions & { status: TaskOutcomeStatus; terminalFailure?: StructuredFailure }): TaskOutcome {
	return createTaskOutcomeFinalizer(input).finalize({ status: input.status, terminalFailure: input.terminalFailure });
}
