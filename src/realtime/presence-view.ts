export type UserPresence = { online: boolean; last_seen: string | null };

export interface PresenceReader {
	getPresence(userId: string, savedLastSeen?: Date | null): UserPresence;
}

// A persisted timestamp is history, not evidence of a live process heartbeat.
export const offlinePresence: PresenceReader = {
	getPresence: (_userId, savedLastSeen) => ({
		online: false,
		last_seen: savedLastSeen?.toISOString() ?? null,
	}),
};
