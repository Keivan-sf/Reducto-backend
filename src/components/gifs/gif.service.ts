import { randomUUID } from "node:crypto";
import {
	FfmpegGifConverter,
	type GifConverter,
} from "../../lib/gif-converter.js";
import { HttpError } from "../../lib/http.js";
import type { ObjectStorage } from "../../lib/object-storage.js";
import type { GifRepository, UserGif } from "./gif.repository.js";

export const MAX_GIF_SIZE_BYTES = 50 * 1024 * 1024;

export class GifService {
	constructor(
		private readonly repository: GifRepository,
		private readonly objectStorage: ObjectStorage,
		private readonly converter: GifConverter = new FfmpegGifConverter(),
	) {}

	async uploadGif(
		userId: string,
		gif: { buffer: Buffer; mimetype: string },
	): Promise<UserGif> {
		if (
			gif.mimetype !== "image/gif" &&
			!gif.mimetype.startsWith("video/") &&
			gif.mimetype !== "application/octet-stream"
		) {
			throw new HttpError(400, "File must be a GIF or video");
		}
		if (gif.buffer.length > MAX_GIF_SIZE_BYTES) {
			throw new HttpError(400, "GIF or video must not exceed 50 MB");
		}
		if (!(await this.repository.userExists(userId))) {
			throw new HttpError(404, "User not found");
		}

		const converted = await this.converter.convertToMp4(gif.buffer);
		const objectKey = `gifs/${userId}/${randomUUID()}.mp4`;
		await this.objectStorage.putObject({
			key: objectKey,
			body: converted,
			contentType: "video/mp4",
		});
		try {
			return await this.repository.createGif({
				userId,
				objectKey,
				fileSize: converted.length,
			});
		} catch (error) {
			await this.objectStorage.deleteObject(objectKey);
			throw error;
		}
	}

	listGifs(userId: string): Promise<UserGif[]> {
		return this.repository.listGifs(userId);
	}

	async deleteGif(userId: string, gifId: string): Promise<void> {
		await this.repository.deleteGif(userId, gifId);
	}

	async addToLibrary(userId: string, gifId: string): Promise<void> {
		if (!(await this.repository.findGif(gifId)))
			throw new HttpError(404, "GIF not found");
		if (!(await this.repository.userExists(userId)))
			throw new HttpError(404, "User not found");
		await this.repository.addToLibrary(userId, gifId);
	}
}
