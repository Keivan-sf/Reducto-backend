import { expect, test } from "@jest/globals";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { FfmpegThumbnailGenerator } from "./video-thumbnail.js";

const executeFile = promisify(execFile);

test("thumbnail is a JPEG of the first frame at the video's dimensions", async () => {
	const directory = await mkdtemp(join(tmpdir(), "reducto-thumbnail-test-"));
	try {
		const path = join(directory, "source.mkv");
		await executeFile("ffmpeg", [
			"-v",
			"error",
			"-f",
			"lavfi",
			"-i",
			"color=c=red:s=64x32:r=1:d=1",
			"-f",
			"lavfi",
			"-i",
			"color=c=blue:s=64x32:r=1:d=1",
			"-filter_complex",
			"[0:v][1:v]concat=n=2:v=1:a=0",
			"-c:v",
			"ffv1",
			path,
		]);
		const thumbnail = await new FfmpegThumbnailGenerator().generate(
			await readFile(path),
		);
		expect(await sharp(thumbnail).metadata()).toMatchObject({
			format: "jpeg",
			width: 64,
			height: 32,
		});
		const [red, green, blue] = await sharp(thumbnail)
			.resize(1, 1)
			.removeAlpha()
			.raw()
			.toBuffer();
		expect(red).toBeGreaterThan(240);
		expect(green).toBeLessThan(15);
		expect(blue).toBeLessThan(15);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("thumbnail follows the displayed orientation of rotated videos", async () => {
	const directory = await mkdtemp(
		join(tmpdir(), "reducto-rotated-thumbnail-test-"),
	);
	try {
		const source = join(directory, "source.mp4");
		const rotated = join(directory, "rotated.mp4");
		await executeFile("ffmpeg", [
			"-v",
			"error",
			"-f",
			"lavfi",
			"-i",
			"color=c=red:s=64x32",
			"-frames:v",
			"1",
			"-c:v",
			"libx264",
			source,
		]);
		await executeFile("ffmpeg", [
			"-v",
			"error",
			"-display_rotation:v:0",
			"90",
			"-i",
			source,
			"-c",
			"copy",
			rotated,
		]);
		const thumbnail = await new FfmpegThumbnailGenerator().generate(
			await readFile(rotated),
		);
		expect(await sharp(thumbnail).metadata()).toMatchObject({
			width: 32,
			height: 64,
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("invalid videos cannot produce a thumbnail", async () => {
	await expect(
		new FfmpegThumbnailGenerator().generate(Buffer.from("not a video")),
	).rejects.toMatchObject({ status: 400 });
});
