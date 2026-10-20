import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { HttpError } from "./http.js";

const executeFile = promisify(execFile);
export type MediaDimensions = { width: number; height: number };
export interface DimensionReader {
	read(input: Buffer, type: "image" | "video"): Promise<MediaDimensions>;
}

export function videoDimensions(stream: {
	width?: number;
	height?: number;
	side_data_list?: { rotation?: number }[];
	tags?: { rotate?: string };
}): MediaDimensions {
	let { width, height } = stream;
	if (
		!Number.isSafeInteger(width) ||
		!Number.isSafeInteger(height) ||
		width! <= 0 ||
		height! <= 0
	)
		throw new Error("Media has no valid dimensions");
	const rotation =
		stream.side_data_list?.find((data) => data.rotation !== undefined)
			?.rotation ?? Number(stream.tags?.rotate ?? 0);
	if (Math.abs(rotation % 180) === 90) [width, height] = [height, width];
	return { width: width!, height: height! };
}

export class MediaDimensionReader implements DimensionReader {
	async read(input: Buffer, type: "image" | "video"): Promise<MediaDimensions> {
		try {
			if (type === "image") {
				const metadata = await sharp(input).metadata();
				// Animated images use one frame's height, not the stacked page height.
				let { width, height } = videoDimensions({
					width: metadata.width,
					height: metadata.pageHeight ?? metadata.height,
				});
				if (metadata.orientation && metadata.orientation >= 5)
					[width, height] = [height, width];
				return { width, height };
			}
			const directory = await mkdtemp(join(tmpdir(), "reducto-dimensions-"));
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
						"-select_streams",
						"v:0",
						"-show_entries",
						"stream=width,height:stream_tags=rotate:stream_side_data=rotation",
						"-of",
						"json",
						path,
					],
					{ timeout: 30_000, maxBuffer: 1024 * 1024 },
				);
				return videoDimensions(JSON.parse(stdout).streams?.[0] ?? {});
			} finally {
				await rm(directory, { recursive: true, force: true });
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT")
				throw new Error("ffprobe is required to read video dimensions", {
					cause: error,
				});
			throw new HttpError(400, "Unable to read image or video dimensions");
		}
	}
}
