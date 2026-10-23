import { existsSync } from "node:fs";
import { Pool } from "pg";
import { z } from "zod";
import { FfprobeDurationReader } from "../lib/media-duration.js";
import { S3ObjectStorage } from "../lib/object-storage.js";
import { backfillMediaDurations } from "./backfill-media-durations.js";

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
		const result = await backfillMediaDurations(
			database,
			new S3ObjectStorage({
				endpoint: env.S3_ENDPOINT,
				bucket: env.S3_BUCKET,
				accessKeyId: env.S3_ACCESS_KEY,
				secretAccessKey: env.S3_SECRET_KEY,
			}),
			new FfprobeDurationReader(),
			(id, error) => {
				console.error(
					`Failed to backfill conversation_media/${id}:`,
					error instanceof Error ? error.message : "Unknown error",
				);
			},
		);
		console.log(
			`Media durations: ${result.updated} updated, ${result.failed} failed.`,
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
