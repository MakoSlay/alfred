export interface AlfredDaemonConfig {
	readonly host: string;
	readonly port: number;
}

export function defaultDaemonConfig(): AlfredDaemonConfig {
	return { host: "127.0.0.1", port: 47321 };
}
