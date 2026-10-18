import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { HttpError } from "./http.js";

const executeFile = promisify(execFile);

export interface GifConverter {
	convertToMp4(input: Buffer): Promise<Buffer>;
}

export class FfmpegGifConverter implements GifConverter {
	async convertToMp4(input: Buffer): Promise<Buffer> {
		const directory = await mkdtemp(join(tmpdir(), "reducto-gif-"));
		const inputPath = join(directory, "input");
		const outputPath = join(directory, "output.mp4");
		try {
			await writeFile(inputPath, input);
			try {
				await executeFile(
					"ffmpeg",
					[
						"-nostdin",
						"-v",
						"error",
						"-y",
						"-protocol_whitelist",
						"file,pipe",
						"-i",
						inputPath,
						"-map",
						"0:v:0",
						"-an",
						"-sn",
						"-dn",
						"-map_metadata",
						"-1",
						"-vf",
						"pad=ceil(iw/2)*2:ceil(ih/2)*2",
						"-c:v",
						"libx264",
						"-pix_fmt",
						"yuv420p",
						"-movflags",
						"+faststart",
						outputPath,
					],
					{ timeout: 120_000, maxBuffer: 1024 * 1024 },
				);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") {
					throw new Error("FFmpeg is required to process GIF uploads", {
						cause: error,
					});
				}
				throw new HttpError(
					400,
					"Unable to convert upload: provide a valid GIF or video",
				);
			}
			return await readFile(outputPath);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	}
}
