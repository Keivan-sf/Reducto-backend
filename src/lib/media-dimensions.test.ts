import { expect, test } from "@jest/globals";
import sharp from "sharp";
import { FfmpegGifConverter } from "./gif-converter.js";
import { MediaDimensionReader, videoDimensions } from "./media-dimensions.js";

const reader = new MediaDimensionReader();

test("image dimensions follow EXIF display orientation", async () => {
	const image = await sharp({
		create: { width: 40, height: 20, channels: 3, background: "red" },
	})
		.jpeg()
		.withMetadata({ orientation: 6 })
		.toBuffer();
	expect(await reader.read(image, "image")).toEqual({ width: 20, height: 40 });
});

test("GIF dimensions describe the converted padded MP4", async () => {
	const gif = Buffer.from(
		"R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
		"base64",
	);
	expect(await reader.read(gif, "image")).toEqual({ width: 1, height: 1 });
	const mp4 = await new FfmpegGifConverter().convertToMp4(gif);
	expect(await reader.read(mp4, "video")).toEqual({ width: 2, height: 2 });
});

test("video rotation swaps display dimensions and invalid dimensions are rejected", () => {
	expect(
		videoDimensions({
			width: 1920,
			height: 1080,
			side_data_list: [{ rotation: -90 }],
		}),
	).toEqual({ width: 1080, height: 1920 });
	expect(
		videoDimensions({ width: 1920, height: 1080, tags: { rotate: "180" } }),
	).toEqual({ width: 1920, height: 1080 });
	expect(() => videoDimensions({ width: 0, height: 20 })).toThrow();
	expect(() => videoDimensions({})).toThrow();
});

test.each(["image", "video"] as const)(
	"invalid %s bytes cannot be uploaded with invented dimensions",
	async (type) => {
		await expect(
			reader.read(Buffer.from("invalid media"), type),
		).rejects.toMatchObject({ status: 400 });
	},
);
