import type { AlfredSource } from "../contracts/runtime.ts";

export function createReadOnlyWebSource(id = "alfred-web-ui"): AlfredSource {
	return {
		kind: "web-ui",
		id,
		label: "Alfred Web UI",
		userIntent: "button",
		trustedLocalOnly: false,
		capabilities: ["world.read", "history.read"],
		presentation: { wantsText: true, style: "compact" },
	};
}
