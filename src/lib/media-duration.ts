import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { HttpError } from "./http.js";

const executeFile = promisify(execFile);

export interface DurationReader {
	read(input: Buffer): Promise<number>;
}

export class FfprobeDurationReader implements DurationReader {
	async read(input: Buffer): Promise<number> {
		const directory = await mkdtemp(join(tmpdir(), "reducto-duration-"));
		try {
			const path = join(directory, "media");
			await writeFile(path, input);
			const { stdout } = await executeFile(
				"ffprobe",
				[
					"-v",
					"error",
					"-protocol_whitelist",
					"file,pipe",
					"-show_entries",
					"format=duration",
					"-of",
					"json",
					path,
				],
				{ timeout: 30_000, maxBuffer: 1024 * 1024 },
			);
			const duration = Number(JSON.parse(stdout).format?.duration);
			if (!Number.isFinite(duration) || duration <= 0)
				throw new HttpError(400, "Unable to read media duration");
			return duration;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT")
				throw new Error("ffprobe is required to read media duration", {
					cause: error,
				});
			if (error instanceof HttpError) throw error;
			throw new HttpError(400, "Unable to read media duration");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	}
}
