// Consume the whole token before checking its length so overlong usernames
// cannot accidentally mention a user whose name is a prefix of the token.
export function mentionedUsernames(text: string | null): string[] {
	const names = new Set<string>();
	for (const match of (text ?? "").matchAll(
		/(?<![\p{L}\p{N}_@])@([A-Za-z0-9_]+)(?![\p{L}\p{N}_])/gu,
	)) {
		if (match[1].length <= 32) names.add(match[1].toLowerCase());
	}
	return [...names];
}
