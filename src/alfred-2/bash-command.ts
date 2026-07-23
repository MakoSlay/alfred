export function validateBashCommandShape(command: string): string | null {
	if (/[\r\n]/.test(command)) return "bash commands must be a single line";
	if (/<<<?-?/.test(command)) return "bash heredoc and here-string operators are not supported; use a typed file or note tool";
	return null;
}
