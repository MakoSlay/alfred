import type { AlfredSource } from "../contracts/runtime.ts";
export * from "./daemon.ts";

export function createCliSource(overrides: Partial<AlfredSource> = {}): AlfredSource {
	return {
		kind: "cli",
		id: "alfred-cli",
		trustedLocalOnly: true,
		capabilities: ["world.read", "history.read"],
		presentation: { wantsText: true, style: "plain" },
		...overrides,
	};
}
