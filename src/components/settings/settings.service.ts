import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { HttpError } from "../../lib/http.js";
import type { ObjectStorage } from "./object-storage.js";
import type {
	SettingsRepository,
	SettingsUser,
} from "./settings.repository.js";

export const MAX_AVATAR_SIZE_BYTES = 5 * 1024 * 1024;

export class SettingsService {
	constructor(
		private readonly repository: SettingsRepository,
		private readonly objectStorage: ObjectStorage,
	) {}

	async updateProfile(
		userId: string,
		changes: { name?: string; username?: string | null },
	): Promise<SettingsUser> {
		const currentUser = await this.repository.findUserById(userId);
		if (!currentUser) throw new HttpError(404, "User not found");

		const username = changes.username?.toLowerCase();
		if (username) {
			const existingUser = await this.repository.findUserByUsername(username);
			if (existingUser && existingUser.id !== userId) {
				throw new HttpError(409, "Username is already registered");
			}
		}

		return this.repository.updateUser(userId, {
			...(changes.name === undefined ? {} : { name: changes.name.trim() }),
			...(changes.username === undefined ? {} : { username }),
		});
	}

	async updateAvatar(
		userId: string,
		avatar: { buffer: Buffer; mimetype: string },
	): Promise<SettingsUser> {
		if (!avatar.mimetype.startsWith("image/")) {
			throw new HttpError(400, "Avatar must be an image");
		}
		if (avatar.buffer.length > MAX_AVATAR_SIZE_BYTES) {
			throw new HttpError(400, "Avatar must not exceed 5 MB");
		}

		let metadata: sharp.Metadata;
		try {
			metadata = await sharp(avatar.buffer, { failOn: "error" }).metadata();
		} catch {
			throw new HttpError(400, "Avatar must be a valid image");
		}
		if (
			!metadata.width ||
			!metadata.height ||
			metadata.width !== metadata.height
		) {
			throw new HttpError(400, "Avatar image must have a 1:1 aspect ratio");
		}
		if (
			!metadata.format ||
			!["jpeg", "png", "webp"].includes(metadata.format)
		) {
			throw new HttpError(400, "Avatar must be a JPEG, PNG, or WebP image");
		}
		if (!(await this.repository.findUserById(userId))) {
			throw new HttpError(404, "User not found");
		}

		const key = `avatars/${userId}/${randomUUID()}.${metadata.format}`;
		await this.objectStorage.putObject({
			key,
			body: avatar.buffer,
			contentType: `image/${metadata.format === "jpeg" ? "jpeg" : metadata.format}`,
		});
		return this.repository.updateUser(userId, { avatarKey: key });
	}
}
