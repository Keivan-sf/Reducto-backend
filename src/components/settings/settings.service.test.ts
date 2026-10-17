import { expect, test } from "@jest/globals";
import sharp from "sharp";
import type { ObjectStorage } from "./object-storage.js";
import {
	InMemorySettingsRepository,
	type SettingsUser,
} from "./settings.repository.js";
import { SettingsService } from "./settings.service.js";

class InMemoryObjectStorage implements ObjectStorage {
	readonly objects = new Map<string, { body: Buffer; contentType: string }>();

	async putObject(input: { key: string; body: Buffer; contentType: string }) {
		this.objects.set(input.key, {
			body: input.body,
			contentType: input.contentType,
		});
	}
}

function createService(users: SettingsUser[]) {
	const storage = new InMemoryObjectStorage();
	return {
		service: new SettingsService(
			new InMemorySettingsRepository(
				new Map(users.map((user) => [user.id, user])),
			),
			storage,
		),
		storage,
	};
}

const ada: SettingsUser = {
	id: "ada-id",
	name: "Ada Lovelace",
	username: "ada",
	avatarKey: null,
};

test("profile updates normalize usernames and keep them unique", async () => {
	const { service } = createService([
		ada,
		{
			id: "grace-id",
			name: "Grace Hopper",
			username: "grace",
			avatarKey: null,
		},
	]);
	const updatedUser = await service.updateProfile("ada-id", {
		name: "Ada King",
		username: "Ada_King",
	});
	expect(updatedUser).toMatchObject({ name: "Ada King", username: "ada_king" });
	await expect(
		service.updateProfile("grace-id", { username: "ADA_KING" }),
	).rejects.toMatchObject({ status: 409 });
});

test("square avatars are stored beneath the avatars object-storage folder", async () => {
	const { service, storage } = createService([ada]);
	const image = await sharp({
		create: { width: 20, height: 20, channels: 4, background: "#000000" },
	})
		.png()
		.toBuffer();
	const updatedUser = await service.updateAvatar("ada-id", {
		buffer: image,
		mimetype: "image/png",
	});
	expect(updatedUser.avatarKey).toMatch(/^avatars\/ada-id\/.*\.png$/);
	expect(storage.objects.has(updatedUser.avatarKey!)).toBe(true);
});

test("non-square avatars are rejected", async () => {
	const { service } = createService([ada]);
	const image = await sharp({
		create: { width: 20, height: 10, channels: 4, background: "#000000" },
	})
		.png()
		.toBuffer();
	await expect(
		service.updateAvatar("ada-id", { buffer: image, mimetype: "image/png" }),
	).rejects.toMatchObject({ status: 400 });
});
