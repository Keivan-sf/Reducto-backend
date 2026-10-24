import { expect, test } from "@jest/globals";
import sharp from "sharp";
import { FfmpegMusicMetadataReader } from "./music-metadata.js";
import { taggedMusic } from "./music-metadata.test-support.js";
import { voiceTestWav } from "./voice-converter.test-support.js";

test("extracts Unicode music tags and embedded cover as a bounded JPEG", async () => {
	const metadata = await new FfmpegMusicMetadataReader().read(
		await taggedMusic(),
	);
	expect(metadata).toMatchObject({ title: "آهنگ Test", artist: "Test Artist" });
	expect(await sharp(metadata.cover!).metadata()).toMatchObject({
		format: "jpeg",
		width: 600,
		height: 300,
	});
});

test("untagged music returns null metadata and invalid files are rejected", async () => {
	const reader = new FfmpegMusicMetadataReader();
	await expect(reader.read(voiceTestWav())).resolves.toEqual({
		title: null,
		artist: null,
		cover: null,
	});
	await expect(reader.read(Buffer.from("invalid"))).rejects.toMatchObject({
		status: 400,
	});
});
