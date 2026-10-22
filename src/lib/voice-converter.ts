import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { HttpError } from "./http.js";

const executeFile = promisify(execFile);

export interface VoiceConverter {
	convertToOgg(input: Buffer): Promise<Buffer>;
}

export class FfmpegVoiceConverter implements VoiceConverter {
	async convertToOgg(input: Buffer): Promise<Buffer> {
		const directory = await mkdtemp(join(tmpdir(), "reducto-voice-"));
		try {
			const inputPath = join(directory, "input");
			const outputPath = join(directory, "voice.ogg");
			await writeFile(inputPath, input);
			try {
				await executeFile(
					"ffmpeg",
					[
						"-nostdin",
						"-v",
						"error",
						"-abort_on",
						"empty_output",
						"-protocol_whitelist",
						"file,pipe",
						"-i",
						inputPath,
						"-map",
						"0:a:0",
						"-vn",
						"-sn",
						"-dn",
						"-map_metadata",
						"-1",
						"-c:a",
						"libopus",
						"-application",
						"voip",
						"-b:a",
						"30k",
						"-vbr",
						"on",
						"-ac",
						"1",
						"-ar",
						"48000",
						"-f",
						"ogg",
						outputPath,
					],
					{ timeout: 120_000, maxBuffer: 1024 * 1024 },
				);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT")
					throw new Error("FFmpeg is required to process voice messages", {
						cause: error,
					});
				throw new HttpError(
					400,
					"Unable to convert voice message: provide a valid audio file",
				);
			}
			return await readFile(outputPath);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	}
}
