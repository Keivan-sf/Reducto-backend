import type { Notifications } from "./notifications.js";
import type { PresenceRepository } from "./presence.repository.js";

export const PRESENCE_INTERVAL_MS = 60_000;

export class PresenceService {
	// Each user appears in exactly one map, with only their latest timestamp.
	// Map membership records whether the online transition has been announced.
	private readonly pending = new Map<string, number>();
	private readonly online = new Map<string, number>();
	private running = false;

	constructor(
		private readonly repository: PresenceRepository,
		private readonly notifications: Notifications,
		private readonly now = Date.now,
	) {}

	heartbeat(userId: string) {
		const target = this.online.has(userId) ? this.online : this.pending;
		target.set(userId, this.now());
	}

	async tick() {
		// Slow database operations must not create overlapping scans.
		if (this.running) return;
		this.running = true;
		try {
			const entries = [...this.pending, ...this.online];
			if (!entries.length) return;
			await this.repository.saveLastSeen(entries);
			for (const [userId, savedTime] of entries) {
				const wasOnline = this.online.has(userId);
				const source = wasOnline ? this.online : this.pending;
				let lastSeen = source.get(userId)!;
				let isOnline = this.now() - lastSeen <= PRESENCE_INTERVAL_MS;
				if (!isOnline && lastSeen !== savedTime) continue;
				if (wasOnline !== isOnline) {
					const peers = await this.repository.findConversationPeerIds(userId);
					// A heartbeat may have arrived during either database operation.
					lastSeen = source.get(userId)!;
					isOnline = this.now() - lastSeen <= PRESENCE_INTERVAL_MS;
					if (!isOnline && lastSeen !== savedTime) continue;
					if (wasOnline !== isOnline) {
						this.notifications.publish(peers, "user.presence", {
							userId,
							online: isOnline,
							last_seen: new Date(lastSeen).toISOString(),
						});
					}
				}
				if (isOnline && !wasOnline) {
					source.delete(userId);
					this.online.set(userId, lastSeen);
				} else if (!isOnline && lastSeen === savedTime) {
					// Only evict timestamps included in the successful database write.
					source.delete(userId);
				}
			}
		} finally {
			this.running = false;
		}
	}
}
