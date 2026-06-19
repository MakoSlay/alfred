import type { AlfredHandleRequest, AlfredHandleResponse } from "../contracts/runtime.ts";

export interface AlfredCore {
	handle(request: AlfredHandleRequest): Promise<AlfredHandleResponse>;
}

export interface AlfredCoreDependencies {
	now?: () => Date;
}

export function createAlfredCorePlaceholder(_dependencies: AlfredCoreDependencies = {}): AlfredCore {
	return {
		async handle(request) {
			return {
				requestId: request.requestId,
				createdAt: new Date().toISOString(),
				ok: false,
				displayText: "Alfred core runtime is not implemented yet.",
				proposedActions: [],
				events: [],
				fallback: { kind: "manual", reason: "Task 002 only creates the project skeleton." },
			};
		},
	};
}
