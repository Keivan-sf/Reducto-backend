import { expect, jest, test } from "@jest/globals";
import sharp from "sharp";
import type { ObjectStorage } from "../../lib/object-storage.js";
import {
	InMemorySettingsRepository,
	type SettingsUser,
} from "./settings.repository.js";
import { SettingsService } from "./settings.service.js";
import type { Notifications } from "../../realtime/notifications.js";

class MemoryNotifications implements Notifications {
	readonly events: { userIds: string[]; event: string; payload: unknown }[] =
		[];
	publish(userIds: string[], event: string, payload: unknown) {
		this.events.push({ userIds, event, payload });
	}
}

class InMemoryObjectStorage implements ObjectStorage {
	readonly objects = new Map<string, { body: Buffer; contentType: string }>();

	async putObject(input: { key: string; body: Buffer; contentType: string }) {
		this.objects.set(input.key, {
			body: input.body,
			contentType: input.contentType,
		});
	}

	async deleteObject(key: string) {
		this.objects.delete(key);
	}
}

function createService(
	users: SettingsUser[],
	memberships = new Map<string, Set<string>>(),
) {
	const storage = new InMemoryObjectStorage();
	const notifications = new MemoryNotifications();
	const repository = new InMemorySettingsRepository(
		new Map(users.map((user) => [user.id, user])),
		memberships,
	);
	return {
		service: new SettingsService(repository, storage, notifications),
		storage,
		notifications,
		repository,
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

test("profile changes notify only distinct direct conversation peers, excluding self and indirect contacts", async () => {
	const memberships = new Map([
		["private", new Set([ada.id, "grace"])],
		["group", new Set([ada.id, "grace", "alan"])],
		["unrelated", new Set(["grace", "outsider"])],
	]);
	const { service, notifications } = createService([ada], memberships);
	await service.updateProfile(ada.id, {
		name: "Ada King",
		username: "ADA_KING",
	});
	expect(notifications.events).toEqual([
		{
			userIds: ["grace", "alan"],
			event: "user.profile_updated",
			payload: { userId: ada.id, changedFields: ["name", "username"] },
		},
	]);
	memberships.get("private")!.delete("grace");
	memberships.get("group")!.delete("grace");
	await service.updateProfile(ada.id, { name: "Ada Byron" });
	expect(notifications.events.at(-1)!.userIds).toEqual(["alan"]);
	memberships.get("group")!.delete(ada.id);
	await service.updateProfile(ada.id, { name: "Ada" });
	expect(notifications.events).toHaveLength(2);
});

test("unchanged normalized fields and rejected updates do not emit notifications", async () => {
	const grace = {
		id: "grace",
		name: "Grace",
		username: "grace",
		avatarKey: null,
	};
	const { service, notifications, repository } = createService(
		[ada, grace],
		new Map([["chat", new Set([ada.id, grace.id])]]),
	);
	await service.updateProfile(ada.id, {
		name: " Ada Lovelace ",
		username: "ADA",
	});
	await expect(
		service.updateProfile(ada.id, { username: "grace" }),
	).rejects.toMatchObject({ status: 409 });
	jest
		.spyOn(repository, "updateUser")
		.mockRejectedValueOnce(new Error("Database unavailable"));
	await expect(
		service.updateProfile(ada.id, { name: "Not persisted" }),
	).rejects.toThrow("Database unavailable");
	expect(notifications.events).toEqual([]);
});

test("clearing a username persists null and notifies peers of the change", async () => {
	const { service, notifications } = createService(
		[ada],
		new Map([["chat", new Set([ada.id, "grace"])]]),
	);
	expect(
		(await service.updateProfile(ada.id, { username: null })).username,
	).toBeNull();
	expect(notifications.events[0].payload).toEqual({
		userId: ada.id,
		changedFields: ["username"],
	});
});

test("avatar notifications are emitted only after the image and profile are saved", async () => {
	const { service, notifications, repository, storage } = createService(
		[ada],
		new Map([["chat", new Set([ada.id, "grace"])]]),
	);
	const image = await sharp({
		create: { width: 20, height: 20, channels: 4, background: "#000000" },
	})
		.png()
		.toBuffer();
	await expect(
		service.updateAvatar(ada.id, {
			buffer: Buffer.from("invalid"),
			mimetype: "image/png",
		}),
	).rejects.toMatchObject({ status: 400 });
	expect(notifications.events).toEqual([]);
	jest
		.spyOn(storage, "putObject")
		.mockRejectedValueOnce(new Error("Storage unavailable"));
	await expect(
		service.updateAvatar(ada.id, { buffer: image, mimetype: "image/png" }),
	).rejects.toThrow("Storage unavailable");
	expect(notifications.events).toEqual([]);
	jest
		.spyOn(repository, "updateUser")
		.mockRejectedValueOnce(new Error("Database unavailable"));
	await expect(
		service.updateAvatar(ada.id, { buffer: image, mimetype: "image/png" }),
	).rejects.toThrow("Database unavailable");
	expect(notifications.events).toEqual([]);
	const updated = await service.updateAvatar(ada.id, {
		buffer: image,
		mimetype: "image/png",
	});
	expect((await repository.findUserById(ada.id))!.avatarKey).toBe(
		updated.avatarKey,
	);
	expect(storage.objects.has(updated.avatarKey!)).toBe(true);
	expect(notifications.events).toEqual([
		{
			userIds: ["grace"],
			event: "user.profile_updated",
			payload: { userId: ada.id, changedFields: ["avatar"] },
		},
	]);
});
