import { asc, gt, sql } from "drizzle-orm";
import type { createDatabase } from "../../db/client.js";
import {
	conversationMedia,
	conversationMembers,
	messages,
} from "../../db/schema.js";

export type CleanupCounts = {
	deletedMessages: number;
	deletedAttachments: number;
};

export interface AdminRepository {
	cleanup(
		deleteFiles: (keys: string[]) => Promise<void>,
	): Promise<CleanupCounts>;
}

export class DrizzleAdminRepository implements AdminRepository {
	constructor(private readonly db: ReturnType<typeof createDatabase>) {}

	async cleanup(deleteFiles: (keys: string[]) => Promise<void>) {
		return this.db.transaction(async (tx) => {
			// Serialize cleanup across processes and keep message/media writes out of
			// the snapshot until both S3 deletion and database cleanup have finished.
			await tx.execute(sql`LOCK TABLE messages, conversation_media,
				conversation_members IN SHARE ROW EXCLUSIVE MODE`);
			let cursor: string | undefined;
			let deletedAttachments = 0;
			while (true) {
				const batch = await tx
					.select({
						id: conversationMedia.id,
						objectKey: conversationMedia.objectKey,
						thumbnailKey: conversationMedia.thumbnailKey,
						coverKey: conversationMedia.coverKey,
					})
					.from(conversationMedia)
					.where(cursor ? gt(conversationMedia.id, cursor) : undefined)
					.orderBy(asc(conversationMedia.id))
					.limit(100);
				if (!batch.length) break;
				await deleteFiles([
					...new Set(
						batch.flatMap((media) =>
							[media.objectKey, media.thumbnailKey, media.coverKey].filter(
								(key): key is string => Boolean(key),
							),
						),
					),
				]);
				deletedAttachments += batch.length;
				cursor = batch[batch.length - 1].id;
			}
			const [count] = await tx
				.select({ value: sql<number>`count(*)::integer` })
				.from(messages);
			// Read markers reference messages without ON DELETE SET NULL.
			await tx.update(conversationMembers).set({ lastSeenMessageId: null });
			// Mentions and reactions cascade; GIF records/libraries are untouched.
			await tx.delete(messages);
			await tx.delete(conversationMedia);
			return { deletedMessages: count.value, deletedAttachments };
		});
	}
}
