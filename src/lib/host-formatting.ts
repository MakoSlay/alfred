export function formatHostForUrl(host: string): string {
	return host.includes(":") ? `[${host.replace(/^\[/, "").replace(/\]$/, "")}]` : host;
}
