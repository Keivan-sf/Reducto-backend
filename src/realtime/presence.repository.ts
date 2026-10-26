import { sql } from "drizzle-orm";
import type { createDatabase } from "../db/client.js";
import { users } from "../db/schema.js";
import { DrizzleSettingsRepository } from "../components/settings/settings.repository.js";

export interface PresenceRepository {
	saveLastSeen(
		entries: ReadonlyArray<readonly [string, number]>,
	): Promise<void>;
	findConversationPeerIds(userId: string): Promise<string[]>;
}

export class DrizzlePresenceRepository implements PresenceRepository {
	constructor(private readonly database: ReturnType<typeof createDatabase>) {}

	async saveLastSeen(entries: ReadonlyArray<readonly [string, number]>) {
		// Bound query size even when many users are active. No query per heartbeat.
		for (let offset = 0; offset < entries.length; offset += 500) {
			const values = entries
				.slice(offset, offset + 500)
				.map(
					([id, time]) =>
						sql`(${id}::uuid, ${new Date(time).toISOString()}::timestamptz)`,
				);
			await this.database.execute(sql`
				UPDATE ${users} SET last_seen = GREATEST(${users.lastSeen}, heartbeat.last_seen)
				FROM (VALUES ${sql.join(values, sql`, `)}) AS heartbeat(id, last_seen)
				WHERE ${users.id} = heartbeat.id
			`);
		}
	}

	findConversationPeerIds(userId: string) {
		return new DrizzleSettingsRepository(this.database).findConversationPeerIds(
			userId,
		);
	}
}
