import type { Pool } from "pg";
import type { DimensionReader } from "../lib/media-dimensions.js";

type StoredMedia = {
	id: string;
	object_key: string;
	type: "image" | "video";
};

export async function backfillMediaDimensions(
	database: Pick<Pool, "query">,
	storage: { getObject(key: string): Promise<Buffer> },
	reader: DimensionReader,
	onError: (table: string, id: string, error: unknown) => void,
) {
	let updated = 0;
	let failed = 0;
	for (const table of ["gifs", "conversation_media"] as const) {
		let cursor: string | null = null;
		for (;;) {
			// Keyset pagination keeps memory bounded and makes restarts skip completed rows.
			const { rows }: { rows: StoredMedia[] } =
				await database.query<StoredMedia>(
					`SELECT id, object_key, ${table === "gifs" ? "'video' AS type" : "type"}
				 FROM ${table}
				 WHERE (width IS NULL OR height IS NULL)
				 ${table === "conversation_media" ? "AND type IN ('image', 'video')" : ""}
				 AND ($1::uuid IS NULL OR id > $1::uuid) ORDER BY id LIMIT 100`,
					[cursor],
				);
			if (!rows.length) break;
			for (const row of rows) {
				try {
					const dimensions = await reader.read(
						await storage.getObject(row.object_key),
						row.type,
					);
					const result = await database.query(
						`UPDATE ${table} SET width = $1, height = $2 WHERE id = $3 AND (width IS NULL OR height IS NULL)`,
						[dimensions.width, dimensions.height, row.id],
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
	if (failed === 0) {
		// NOT VALID checks already protect new writes. Validate historical rows only
		// after every object was processed; no files or records are deleted on failure.
		await database.query(
			'ALTER TABLE "gifs" VALIDATE CONSTRAINT "gifs_dimensions_required"',
		);
		await database.query(
			'ALTER TABLE "conversation_media" VALIDATE CONSTRAINT "conversation_media_dimensions_required"',
		);
	}
	return { updated, failed };
}
