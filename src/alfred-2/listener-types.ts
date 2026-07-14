export type Alfred2ListenerProvider = "off" | "wispr" | "native";

export type Alfred2ListenerRuntimeState =
	| "off"
	| "starting"
	| "wake_listening"
	| "recording_command"
	| "transcribing"
	| "posting"
	| "error"
	| "stopped";

export interface Alfred2ListenerStatus {
	provider: Alfred2ListenerProvider;
	running: boolean;
	state: Alfred2ListenerRuntimeState;
	/** True when this listener is expected to have an active microphone/audio capture path. */
	micActive: boolean;
	wakeWords: string[];
	lastWakeAt: string | null;
	lastCommandAt: string | null;
	lastError: string | null;
	detail?: string;
}

export interface Alfred2Listener {
	start(): Promise<void>;
	stop(): void;
	isRunning(): boolean;
	getStatus(): Alfred2ListenerStatus;
}

export function createOffListenerStatus(provider: Alfred2ListenerProvider = "off", detail = "No voice listener configured."): Alfred2ListenerStatus {
	return {
		provider,
		running: false,
		state: "off",
		micActive: false,
		wakeWords: [],
		lastWakeAt: null,
		lastCommandAt: null,
		lastError: null,
		detail,
	};
}
