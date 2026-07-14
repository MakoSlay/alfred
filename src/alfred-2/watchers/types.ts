import type { ProactiveDecision, ProactiveEvent, RuntimeInterruptionState } from "../proactive/types.ts";

export interface ProactiveDeliveryFunctions {
	speak(text: string): Promise<boolean>;
	notify(title: string, body: string): Promise<void>;
	isMuted(): boolean;
}

export interface WatcherEmitResult {
	event: ProactiveEvent;
	decision: ProactiveDecision;
	delivered: boolean;
}

export interface WatcherTickContext {
	runtime: RuntimeInterruptionState;
}
