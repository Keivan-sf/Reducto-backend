import type { Pool } from "pg";
import type { DurationReader } from "../lib/media-duration.js";

type StoredMedia = { id: string; object_key: string };

export async function backfillMediaDurations(
	database: Pick<Pool, "query">,
	storage: { getObject(key: string): Promise<Buffer> },
	reader: DurationReader,
	onError: (id: string, error: unknown) => void,
) {
	let updated = 0;
	let failed = 0;
	let cursor: string | null = null;
	for (;;) {
		const { rows }: { rows: StoredMedia[] } = await database.query<StoredMedia>(
			`SELECT id, object_key FROM conversation_media
			 WHERE type IN ('video', 'voice', 'music')
			 AND (duration_seconds IS NULL OR duration_seconds = 0)
			 AND ($1::uuid IS NULL OR id > $1::uuid) ORDER BY id LIMIT 100`,
			[cursor],
		);
		if (!rows.length) break;
		for (const row of rows) {
			try {
				const durationSeconds = await reader.read(
					await storage.getObject(row.object_key),
				);
				const result = await database.query(
					`UPDATE conversation_media SET duration_seconds = $1
					 WHERE id = $2 AND (duration_seconds IS NULL OR duration_seconds = 0)`,
					[durationSeconds, row.id],
				);
				updated += result.rowCount ?? 0;
			} catch (error) {
				failed++;
				onError(row.id, error);
			}
		}
		cursor = rows[rows.length - 1].id;
	}
	if (failed === 0) {
		await database.query(
			'ALTER TABLE "conversation_media" VALIDATE CONSTRAINT "conversation_media_duration_required"',
		);
	}
	return { updated, failed };
}
