import { existsSync } from "node:fs";
import { Pool } from "pg";
import { z } from "zod";
import { FfmpegThumbnailGenerator } from "../lib/video-thumbnail.js";
import { S3ObjectStorage } from "../lib/object-storage.js";
import { backfillVideoThumbnails } from "./backfill-video-thumbnails.js";

async function main() {
	if (existsSync(".env")) process.loadEnvFile(".env");
	const env = z
		.object({
			DATABASE_URL: z.string().url(),
			S3_ENDPOINT: z.string().url(),
			S3_BUCKET: z.string().min(1),
			S3_ACCESS_KEY: z.string().min(1),
			S3_SECRET_KEY: z.string().min(1),
		})
		.parse(process.env);
	const database = new Pool({ connectionString: env.DATABASE_URL });
	try {
		const result = await backfillVideoThumbnails(
			database,
			new S3ObjectStorage({
				endpoint: env.S3_ENDPOINT,
				bucket: env.S3_BUCKET,
				accessKeyId: env.S3_ACCESS_KEY,
				secretAccessKey: env.S3_SECRET_KEY,
			}),
			new FfmpegThumbnailGenerator(),
			(table, id, error) => {
				console.error(
					`Failed to backfill ${table}/${id}:`,
					error instanceof Error ? error.message : "Unknown error",
				);
			},
		);
		console.log(
			`Video thumbnails: ${result.updated} updated, ${result.failed} failed.`,
		);
		if (result.failed) process.exitCode = 1;
	} finally {
		await database.end();
	}
}

void main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : "Backfill failed");
	process.exitCode = 1;
});
