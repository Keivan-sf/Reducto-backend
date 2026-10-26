import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { HttpError } from "./http.js";

const executeFile = promisify(execFile);

export interface ThumbnailGenerator {
	generate(input: Buffer): Promise<Buffer>;
}

export class FfmpegThumbnailGenerator implements ThumbnailGenerator {
	async generate(input: Buffer): Promise<Buffer> {
		const directory = await mkdtemp(join(tmpdir(), "reducto-thumbnail-"));
		try {
			const inputPath = join(directory, "input");
			const outputPath = join(directory, "thumbnail.jpg");
			await writeFile(inputPath, input);
			try {
				// Decode from the beginning without seeking: use the first displayed frame.
				// FFmpeg applies video rotation automatically; keep the original dimensions.
				await executeFile(
					"ffmpeg",
					[
						"-nostdin",
						"-v",
						"error",
						"-protocol_whitelist",
						"file,pipe",
						"-i",
						inputPath,
						"-map",
						"0:v:0",
						"-frames:v",
						"1",
						"-an",
						"-sn",
						"-dn",
						"-map_metadata",
						"-1",
						"-c:v",
						"mjpeg",
						"-q:v",
						"2",
						"-update",
						"1",
						outputPath,
					],
					{ maxBuffer: 1024 * 1024 },
				);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT")
					throw new Error("FFmpeg is required to generate video thumbnails", {
						cause: error,
					});
				throw new HttpError(
					400,
					"Unable to generate a thumbnail: provide a valid video",
				);
			}
			// Some empty streams exit successfully without producing a frame.
			try {
				const thumbnail = await readFile(outputPath);
				if (!thumbnail.length) throw new Error("Empty thumbnail");
				return thumbnail;
			} catch {
				throw new HttpError(400, "Video has no frame for a thumbnail");
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	}
}
