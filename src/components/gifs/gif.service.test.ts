import { expect, test } from "@jest/globals";
import type { ObjectStorage } from "../../lib/object-storage.js";
import { InMemoryGifRepository } from "./gif.repository.js";
import { GifService, MAX_GIF_SIZE_BYTES } from "./gif.service.js";

class InMemoryObjectStorage implements ObjectStorage {
	readonly objects = new Map<string, Buffer>();

	async putObject(input: { key: string; body: Buffer }) {
		this.objects.set(input.key, input.body);
	}

	async deleteObject(key: string) {
		this.objects.delete(key);
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
	expect(gif.objectKey).toMatch(/^gifs\/ada-id\/.*\.mp4$/);
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
	expect(await repository.findGif(gif.id)).toEqual(gif);
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
	const service = new GifService(repository, storage, {
		async convertToMp4() {
			return converted;
		},
	});
	const gif = await service.uploadGif("ada-id", {
		buffer: Buffer.from("source video"),
		mimetype: "video/webm",
	});
	expect(gif.fileSize).toBe(converted.length);
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
