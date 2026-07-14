export const TASK_OUTCOME_CONTRACT_VERSION = 1 as const;

export type FailureStage =
	| "control"
	| "route"
	| "plan"
	| "parse"
	| "authorize"
	| "resolve"
	| "execute"
	| "verify"
	| "deliver"
	| "budget";

export type TaskOutcomeStatus =
	| "completed"
	| "partial"
	| "needs_user_input"
	| "needs_capability"
	| "blocked"
	| "failed"
	| "cancelled"
	| "handed_off";

export interface FailureDetector {
	id: string;
	version: number;
}
