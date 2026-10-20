import type { Pool } from "pg";
import sharp from "sharp";
import type { ObjectStorage } from "../lib/object-storage.js";
import type { ThumbnailGenerator } from "../lib/video-thumbnail.js";

type StoredVideo = { id: string; object_key: string };

export async function backfillVideoThumbnails(
	database: Pick<Pool, "query">,
	storage: Pick<ObjectStorage, "putObject"> & {
		getObject(key: string): Promise<Buffer>;
	},
	generator: ThumbnailGenerator,
	onError: (table: string, id: string, error: unknown) => void,
) {
	let updated = 0;
	let failed = 0;
	for (const table of ["gifs", "conversation_media"] as const) {
		let cursor: string | null = null;
		for (;;) {
			const { rows }: { rows: StoredVideo[] } =
				await database.query<StoredVideo>(
					`SELECT id, object_key FROM ${table} WHERE thumbnail_key IS NULL
				 ${table === "conversation_media" ? "AND type = 'video'" : ""}
				 AND ($1::uuid IS NULL OR id > $1::uuid) ORDER BY id LIMIT 100`,
					[cursor],
				);
			if (!rows.length) break;
			for (const row of rows) {
				try {
					const thumbnail = await generator.generate(
						await storage.getObject(row.object_key),
					);
					const { width, height } = await sharp(thumbnail).metadata();
					if (!width || !height) throw new Error("Thumbnail has no dimensions");
					// Reuse the same key on retries, including after a database write fails.
					const key = `thumbnails/${table}/${row.id}.jpg`;
					await storage.putObject({
						key,
						body: thumbnail,
						contentType: "image/jpeg",
					});
					const result = await database.query(
						`UPDATE ${table} SET thumbnail_key = $1,
						 width = COALESCE(width, $2), height = COALESCE(height, $3)
						 WHERE id = $4 AND thumbnail_key IS NULL`,
						[key, width, height, row.id],
					);
					updated += result.rowCount ?? 0;
				} catch (error) {
					failed++;
					onError(table, row.id, error);
				}
			}
			cursor = rows[rows.length - 1].id;
		}
	}
	if (!failed) {
		await database.query(
			'ALTER TABLE "gifs" VALIDATE CONSTRAINT "gifs_thumbnail_required"',
		);
		await database.query(
			'ALTER TABLE "conversation_media" VALIDATE CONSTRAINT "conversation_media_thumbnail_required"',
		);
	}
	return { updated, failed };
}
