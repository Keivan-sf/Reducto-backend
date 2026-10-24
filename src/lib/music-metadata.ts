import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { HttpError } from "./http.js";

const executeFile = promisify(execFile);

export interface MusicMetadataReader {
	read(input: Buffer): Promise<{
		title: string | null;
		artist: string | null;
		cover: Buffer | null;
	}>;
}

type Stream = {
	index: number;
	codec_type?: string;
	tags?: Record<string, string>;
	disposition?: { attached_pic?: number };
};

function tag(tags: Record<string, string> | undefined, name: string) {
	const value = Object.entries(tags ?? {}).find(
		([key]) => key.toLowerCase() === name,
	)?.[1];
	return value?.trim() || null;
}

export class FfmpegMusicMetadataReader implements MusicMetadataReader {
	async read(input: Buffer) {
		const directory = await mkdtemp(join(tmpdir(), "reducto-music-"));
		try {
			const path = join(directory, "music");
			await writeFile(path, input);
			const { stdout } = await executeFile(
				"ffprobe",
				[
					"-v",
					"error",
					"-protocol_whitelist",
					"file,pipe",
					"-show_entries",
					"format_tags:stream=index,codec_type:stream_tags:stream_disposition=attached_pic",
					"-of",
					"json",
					path,
				],
				{ timeout: 30_000, maxBuffer: 1024 * 1024 },
			);
			const data: {
				format?: { tags?: Record<string, string> };
				streams?: Stream[];
			} = JSON.parse(stdout);
			const audio = data.streams?.find(
				(stream) => stream.codec_type === "audio",
			);
			if (!audio)
				throw new HttpError(400, "Music must contain an audio stream");
			const picture = data.streams?.find(
				(stream) => stream.disposition?.attached_pic === 1,
			);
			let cover: Buffer | null = null;
			if (picture) {
				const result = await executeFile(
					"ffmpeg",
					[
						"-nostdin",
						"-v",
						"error",
						"-protocol_whitelist",
						"file,pipe",
						"-i",
						path,
						"-map",
						`0:${picture.index}`,
						"-frames:v",
						"1",
						"-vf",
						"scale=600:600:force_original_aspect_ratio=decrease",
						"-an",
						"-map_metadata",
						"-1",
						"-c:v",
						"mjpeg",
						"-f",
						"image2pipe",
						"pipe:1",
					],
					{ encoding: "buffer", timeout: 30_000, maxBuffer: 5 * 1024 * 1024 },
				);
				if (!result.stdout.length)
					throw new HttpError(400, "Unable to read music cover");
				cover = result.stdout;
			}
			return {
				title: tag(data.format?.tags, "title") ?? tag(audio.tags, "title"),
				artist: tag(data.format?.tags, "artist") ?? tag(audio.tags, "artist"),
				cover,
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT")
				throw new Error(
					"ffprobe and FFmpeg are required to read music metadata",
					{ cause: error },
				);
			if (error instanceof HttpError) throw error;
			throw new HttpError(400, "Unable to read music metadata");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	}
}
