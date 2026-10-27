import {
	FfmpegThumbnailGenerator,
	type ThumbnailGenerator,
} from "../../lib/video-thumbnail.js";
import {
	MediaDimensionReader,
	type DimensionReader,
} from "../../lib/media-dimensions.js";
import { randomUUID } from "node:crypto";
import {
	FfmpegGifConverter,
	type GifConverter,
} from "../../lib/gif-converter.js";
import { HttpError } from "../../lib/http.js";
import type { ObjectStorage } from "../../lib/object-storage.js";
import type { GifRepository, UserGif } from "./gif.repository.js";

export const MAX_GIF_SIZE_BYTES = 2 * 1024 * 1024 * 1024;

export interface GifObjectStorage extends ObjectStorage {
	getPlaybackUrl(key: string): Promise<string>;
	getThumbnailUrl(key: string): Promise<string>;
}

export type GifDetails = UserGif & {
	playbackUrl: string;
	thumbnailUrl: string | null;
};

export class GifService {
	constructor(
		private readonly repository: GifRepository,
		private readonly objectStorage: GifObjectStorage,
		private readonly converter: GifConverter = new FfmpegGifConverter(),
		private readonly dimensions: DimensionReader = new MediaDimensionReader(),
		private readonly thumbnails: ThumbnailGenerator = new FfmpegThumbnailGenerator(),
	) {}

	async uploadGif(
		userId: string,
		gif: { buffer: Buffer; mimetype: string },
	): Promise<GifDetails> {
		if (
			gif.mimetype !== "image/gif" &&
			!gif.mimetype.startsWith("video/") &&
			gif.mimetype !== "application/octet-stream"
		) {
			throw new HttpError(400, "File must be a GIF or video");
		}
		if (gif.buffer.length > MAX_GIF_SIZE_BYTES) {
			throw new HttpError(400, "GIF or video must not exceed 2 GB");
		}
		if (!(await this.repository.userExists(userId))) {
			throw new HttpError(404, "User not found");
		}

		const converted = await this.converter.convertToMp4(gif.buffer);
		const dimensions = await this.dimensions.read(converted, "video");
		const thumbnail = await this.thumbnails.generate(converted);
		const thumbnailKey = `thumbnails/gifs/${userId}/${randomUUID()}.jpg`;
		const objectKey = `gifs/${userId}/${randomUUID()}.mp4`;
		let record: UserGif;
		try {
			await this.objectStorage.putObject({
				key: objectKey,
				body: converted,
				contentType: "video/mp4",
			});
			await this.objectStorage.putObject({
				key: thumbnailKey,
				body: thumbnail,
				contentType: "image/jpeg",
			});
			record = await this.repository.createGif({
				userId,
				objectKey,
				thumbnailKey,
				fileSize: converted.length,
				...dimensions,
			});
		} catch (error) {
			await Promise.allSettled([
				this.objectStorage.deleteObject(objectKey),
				this.objectStorage.deleteObject(thumbnailKey),
			]);
			throw error;
		}
		return this.withPlaybackUrl(record);
	}

	private async withPlaybackUrl(gif: UserGif): Promise<GifDetails> {
		return {
			...gif,
			playbackUrl: await this.objectStorage.getPlaybackUrl(gif.objectKey),
			thumbnailUrl: gif.thumbnailKey
				? await this.objectStorage.getThumbnailUrl(gif.thumbnailKey)
				: null,
		};
	}

	async listGifs(userId: string): Promise<GifDetails[]> {
		const gifs = await this.repository.listGifs(userId);
		return Promise.all(gifs.map((gif) => this.withPlaybackUrl(gif)));
	}

	async getGif(gifId: string): Promise<GifDetails> {
		const gif = await this.repository.findGif(gifId);
		if (!gif) throw new HttpError(404, "GIF not found");
		return this.withPlaybackUrl(gif);
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
