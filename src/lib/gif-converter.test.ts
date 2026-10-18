import { expect, test } from "@jest/globals";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { FfmpegGifConverter } from "./gif-converter.js";

const executeFile = promisify(execFile);

test("FFmpeg converts a video containing audio into a muted H.264 MP4", async () => {
	const directory = await mkdtemp(join(tmpdir(), "reducto-converter-test-"));
	try {
		const inputPath = join(directory, "source.mkv");
		await executeFile("ffmpeg", [
			"-v",
			"error",
			"-f",
			"lavfi",
			"-i",
			"color=size=32x32:rate=10",
			"-f",
			"lavfi",
			"-i",
			"sine=frequency=1000",
			"-t",
			"0.3",
			"-c:v",
			"ffv1",
			"-c:a",
			"pcm_s16le",
			inputPath,
		]);
		const converted = await new FfmpegGifConverter().convertToMp4(
			await readFile(inputPath),
		);
		const outputPath = join(directory, "result.mp4");
		await writeFile(outputPath, converted);
		const { stdout } = await executeFile("ffprobe", [
			"-v",
			"error",
			"-show_streams",
			"-show_format",
			"-of",
			"json",
			outputPath,
		]);
		const metadata = JSON.parse(stdout);
		expect(metadata.format.format_name).toContain("mp4");
		expect(metadata.streams).toHaveLength(1);
		expect(metadata.streams[0]).toMatchObject({
			codec_type: "video",
			codec_name: "h264",
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("FFmpeg converts an odd-sized GIF to MP4", async () => {
	const input = Buffer.from(
		"R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
		"base64",
	);
	const result = await new FfmpegGifConverter().convertToMp4(input);
	expect(result.toString("ascii", 4, 8)).toBe("ftyp");
});
