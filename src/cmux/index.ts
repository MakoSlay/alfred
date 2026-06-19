import type { AlfredTarget } from "../contracts/runtime.ts";

export interface CmuxWorldModelAdapter {
	listTargets(): Promise<AlfredTarget[]>;
}

export function createCmuxAdapterPlaceholder(): CmuxWorldModelAdapter {
	return {
		async listTargets() {
			return [];
		},
	};
}
