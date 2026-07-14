export function normalizeHttpUrl(value: string): string | null {
	if (value !== value.trim() || value.length === 0) return null;
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
	} catch {
		return null;
	}
}

export function isSafeRelativePath(path: string): boolean {
	if (path !== path.trim()) return false;
	if (path.length === 0) return false;
	if (path.startsWith("/") || path.startsWith("\\") || path.startsWith("~") || path.startsWith("-")) return false;
	if (path.includes(":")) return false;
	const parts = path.split(/[\\/]+/).filter(Boolean);
	return parts.length > 0 && parts.every((part) => part !== "." && part !== ".." && !part.startsWith("-"));
}

export function isSafeRelativeMarkdownPath(path: string): boolean {
	return /\.(?:md|markdown)$/i.test(path) && isSafeRelativePath(path);
}
