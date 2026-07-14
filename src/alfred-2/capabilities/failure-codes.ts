import type { FailureDetector, FailureStage } from "./types.ts";

export const STRUCTURED_FAILURE_CONTRACT_VERSION = 1 as const;

export type FailureCode =
	| "control.user_cancelled"
	| "contract.invalid_input"
	| "plan.no_matching_capability"
	| "plan.existing_tool_not_selected"
	| "parser.invalid_output"
	| "parser.unknown_tool"
	| "parser.invalid_tool_arguments"
	| "precondition.missing_config"
	| "precondition.missing_credentials"
	| "precondition.dependency_unavailable"
	| "precondition.platform_unavailable"
	| "resolution.ambiguous_request"
	| "resolution.ambiguous_target"
	| "resolution.target_not_found"
	| "policy.blocked"
	| "confirmation.required"
	| "confirmation.denied"
	| "confirmation.expired"
	| "execution.timeout"
	| "execution.rate_limited"
	| "execution.provider_5xx"
	| "execution.network_transient"
	| "execution.invalid_arguments"
	| "execution.exit_nonzero"
	| "execution.internal_error"
	| "verification.invariant_failed"
	| "budget.max_rounds"
	| "budget.request_timeout"
	| "budget.context_handoff"
	| "capability.explicitly_unsupported"
	| "capability.impossible_on_platform"
	| "outcome.unclassified";

export interface StructuredFailure {
	contractVersion: typeof STRUCTURED_FAILURE_CONTRACT_VERSION;
	stage: FailureStage;
	code: FailureCode;
	component: string;
	message: string;
	retryable: boolean;
	timedOut?: boolean;
	rateLimited?: boolean;
	httpStatus?: number;
	configKeysMissing?: string[];
	detector: FailureDetector;
}
