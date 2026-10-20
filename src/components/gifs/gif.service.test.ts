import { expect, jest, test } from "@jest/globals";
import { InMemoryGifRepository } from "./gif.repository.js";
import {
	GifService,
	MAX_GIF_SIZE_BYTES,
	type GifObjectStorage,
} from "./gif.service.js";

class InMemoryObjectStorage implements GifObjectStorage {
	readonly objects = new Map<string, Buffer>();

	async putObject(input: { key: string; body: Buffer }) {
		this.objects.set(input.key, input.body);
	}

	async deleteObject(key: string) {
		this.objects.delete(key);
	}

	async getThumbnailUrl(key: string) {
		return `https://storage.example/${key}?signed=true`;
	}

	async getPlaybackUrl(key: string) {
		return `https://storage.example/${key}?signed=true`;
	}
}

const validGif = Buffer.from(
	"R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
	"base64",
);

test("a user can store and remove their own GIF", async () => {
	const storage = new InMemoryObjectStorage();
	const service = new GifService(
		new InMemoryGifRepository(new Set(["ada-id"])),
		storage,
	);
	const gif = await service.uploadGif("ada-id", {
		buffer: validGif,
		mimetype: "image/gif",
	});
	expect(gif).toMatchObject({ width: 2, height: 2 });
	expect(storage.objects.has(gif.thumbnailKey!)).toBe(true);
	expect(gif.thumbnailUrl).toBe(
		`https://storage.example/${gif.thumbnailKey}?signed=true`,
	);
	expect(gif.objectKey).toMatch(/^gifs\/ada-id\/.*\.mp4$/);
	expect(gif.playbackUrl).toBe(
		`https://storage.example/${gif.objectKey}?signed=true`,
	);
	expect(await service.listGifs("ada-id")).toHaveLength(1);
	expect(storage.objects.has(gif.objectKey)).toBe(true);

	await service.deleteGif("ada-id", gif.id);
	expect(await service.listGifs("ada-id")).toHaveLength(0);
	expect(storage.objects.has(gif.objectKey)).toBe(true);
});

test("libraries share a stable GIF ID and removal does not delete the GIF", async () => {
	const repository = new InMemoryGifRepository(new Set(["ada-id", "grace-id"]));
	const storage = new InMemoryObjectStorage();
	const service = new GifService(repository, storage);
	const gif = await service.uploadGif("ada-id", {
		buffer: validGif,
		mimetype: "image/gif",
	});
	await service.addToLibrary("grace-id", gif.id);
	await service.addToLibrary("grace-id", gif.id);
	expect(await service.listGifs("grace-id")).toEqual([gif]);
	await service.deleteGif("ada-id", gif.id);
	const { playbackUrl, thumbnailUrl, ...record } = gif;
	expect(await repository.findGif(gif.id)).toEqual(record);
	expect(await service.listGifs("grace-id")).toEqual([gif]);
	expect(storage.objects.has(gif.objectKey)).toBe(true);
});

test("unknown GIF IDs cannot be added to a library", async () => {
	const service = new GifService(
		new InMemoryGifRepository(new Set(["ada-id"])),
		new InMemoryObjectStorage(),
	);
	await expect(
		service.addToLibrary("ada-id", crypto.randomUUID()),
	).rejects.toMatchObject({ status: 404 });
});

test("GIF uploads reject non-GIF content", async () => {
	const service = new GifService(
		new InMemoryGifRepository(new Set(["ada-id"])),
		new InMemoryObjectStorage(),
	);
	await expect(
		service.uploadGif("ada-id", {
			buffer: Buffer.from("not an image"),
			mimetype: "image/gif",
		}),
	).rejects.toMatchObject({ status: 400 });
});

test("video uploads store converted bytes and size", async () => {
	const repository = new InMemoryGifRepository(new Set(["ada-id"]));
	const storage = new InMemoryObjectStorage();
	const converted = Buffer.from("converted mp4");
	const service = new GifService(
		repository,
		storage,
		{
			async convertToMp4() {
				return converted;
			},
		},
		{
			async read() {
				return { width: 320, height: 180 };
			},
		},
		{
			async generate() {
				return Buffer.from("jpeg");
			},
		},
	);
	const gif = await service.uploadGif("ada-id", {
		buffer: Buffer.from("source video"),
		mimetype: "video/webm",
	});
	expect(gif.fileSize).toBe(converted.length);
	expect(gif).toMatchObject({ width: 320, height: 180 });
	expect(storage.objects.get(gif.objectKey)).toEqual(converted);
	expect(await service.listGifs("ada-id")).toEqual([gif]);
});

test("uploads larger than 50 MB are rejected before conversion or storage", async () => {
	const storage = new InMemoryObjectStorage();
	const service = new GifService(
		new InMemoryGifRepository(new Set(["ada-id"])),
		storage,
	);
	await expect(
		service.uploadGif("ada-id", {
			buffer: Buffer.alloc(MAX_GIF_SIZE_BYTES + 1),
			mimetype: "video/mp4",
		}),
	).rejects.toMatchObject({ status: 400 });
	expect(storage.objects.size).toBe(0);
});

test("GIF lookups and library lists generate fresh playback URLs without persisting them", async () => {
	const repository = new InMemoryGifRepository(new Set(["ada-id"]));
	const storage = new InMemoryObjectStorage();
	const service = new GifService(
		repository,
		storage,
		{
			async convertToMp4() {
				return Buffer.from("mp4");
			},
		},
		{
			async read() {
				return { width: 320, height: 180 };
			},
		},
		{
			async generate() {
				return Buffer.from("jpeg");
			},
		},
	);
	const gif = await service.uploadGif("ada-id", {
		buffer: Buffer.from("video"),
		mimetype: "video/mp4",
	});
	const signer = jest
		.spyOn(storage, "getPlaybackUrl")
		.mockResolvedValueOnce("https://storage.example/first")
		.mockResolvedValueOnce("https://storage.example/refreshed");
	expect((await service.getGif(gif.id)).playbackUrl).toBe(
		"https://storage.example/first",
	);
	expect((await service.listGifs("ada-id"))[0].playbackUrl).toBe(
		"https://storage.example/refreshed",
	);
	expect(signer).toHaveBeenNthCalledWith(1, gif.objectKey);
	expect(signer).toHaveBeenNthCalledWith(2, gif.objectKey);
	expect(await repository.findGif(gif.id)).not.toHaveProperty("playbackUrl");
	await expect(service.getGif(crypto.randomUUID())).rejects.toMatchObject({
		status: 404,
	});
});

test("a playback signing failure does not delete a successfully saved MP4", async () => {
	const repository = new InMemoryGifRepository(new Set(["ada-id"]));
	const storage = new InMemoryObjectStorage();
	jest
		.spyOn(storage, "getPlaybackUrl")
		.mockRejectedValueOnce(new Error("Signing unavailable"));
	const service = new GifService(
		repository,
		storage,
		{
			async convertToMp4() {
				return Buffer.from("mp4");
			},
		},
		{
			async read() {
				return { width: 320, height: 180 };
			},
		},
		{
			async generate() {
				return Buffer.from("jpeg");
			},
		},
	);
	await expect(
		service.uploadGif("ada-id", {
			buffer: Buffer.from("video"),
			mimetype: "video/mp4",
		}),
	).rejects.toThrow("Signing unavailable");
	const [saved] = await repository.listGifs("ada-id");
	expect(storage.objects.has(saved.objectKey)).toBe(true);
	expect((await service.getGif(saved.id)).playbackUrl).toContain(
		saved.objectKey,
	);
});
