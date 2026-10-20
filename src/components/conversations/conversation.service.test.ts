import sharp from "sharp";
import { expect, jest, test } from "@jest/globals";
import { randomUUID } from "node:crypto";
import { ConversationService } from "./conversation.service.js";
import {
	MemoryChatStorage,
	MemoryConversationRepository,
	MemoryNotifications,
} from "./conversation.test-support.js";

function fixture() {
	const repository = new MemoryConversationRepository();
	const storage = new MemoryChatStorage();
	const notifications = new MemoryNotifications();
	const owner = randomUUID(),
		admin = randomUUID(),
		member = randomUUID(),
		outsider = randomUUID();
	for (const userId of [owner, admin, member, outsider])
		repository.users.add(userId);
	return {
		repository,
		storage,
		notifications,
		owner,
		admin,
		member,
		outsider,
		service: new ConversationService(repository, storage, notifications),
	};
}

test("sending a private message creates one conversation per pair and notifies only its members", async () => {
	const { service, owner, member, outsider, notifications } = fixture();
	const message = await service.sendPrivate(owner, member, { text: "Hello" });
	const reverse = await service.createPrivate(member, owner);
	expect(reverse.id).toBe(message.conversationId);
	expect(await service.listConversations(outsider)).toEqual([]);
	expect(notifications.events[0]).toMatchObject({
		event: "message.created",
		userIds: expect.arrayContaining([owner, member]),
	});
	expect(notifications.events[0].userIds).not.toContain(outsider);
	await expect(
		service.sendMessage(outsider, reverse.id, { text: "Intrude" }),
	).rejects.toMatchObject({ status: 403 });
	await expect(
		service.listMessages(outsider, reverse.id, 50),
	).rejects.toMatchObject({ status: 403 });
});

test("messages reject empty bodies, forged sender fields, and multiple attachments", async () => {
	const { service, owner, member } = fixture();
	const chat = await service.createPrivate(owner, member);
	await expect(service.sendMessage(owner, chat.id, {})).rejects.toMatchObject({
		status: 400,
	});
	await expect(
		service.sendMessage(owner, chat.id, { text: "   " }),
	).rejects.toMatchObject({ status: 400 });
	await expect(
		service.sendMessage(owner, chat.id, {
			text: "Hello",
			senderId: member,
		} as never),
	).rejects.toMatchObject({ status: 400 });
	await expect(
		service.sendMessage(owner, chat.id, { attachment: [] } as never),
	).rejects.toMatchObject({ status: 400 });
});

test("owner-only admin management and group deletion, manager edits, and owner protection", async () => {
	const { service, repository, owner, admin, member } = fixture();
	const group = await service.createGroup(owner, "Our group");
	await service.addMember(owner, group.id, admin);
	await service.addMember(owner, group.id, member);
	await service.setRole(owner, group.id, admin, "admin");
	await service.renameGroup(admin, group.id, "Updated");
	expect((await service.getConversation(member, group.id)).name).toBe(
		"Updated",
	);
	await expect(
		service.setRole(admin, group.id, member, "admin"),
	).rejects.toMatchObject({ status: 403 });
	await expect(service.deleteGroup(admin, group.id)).rejects.toMatchObject({
		status: 403,
	});
	await expect(
		service.removeMember(admin, group.id, owner),
	).rejects.toMatchObject({ status: 403 });
	await expect(service.leaveGroup(owner, group.id)).rejects.toMatchObject({
		status: 400,
	});
	await expect(
		service.renameGroup(member, group.id, "Forbidden"),
	).rejects.toMatchObject({ status: 403 });
	await service.deleteGroup(owner, group.id);
	expect(await repository.getConversation(group.id)).toBeUndefined();
});

test("invite joins are idempotent and removed members lose history and notifications", async () => {
	const { service, repository, notifications, owner, member } = fixture();
	const group = await service.createGroup(owner, "Group");
	const token = group.inviteLink.split("/").at(-1)!;
	await service.joinGroup(member, token);
	await service.joinGroup(member, token);
	expect(await service.listMembers(owner, group.id)).toHaveLength(2);
	await service.removeMember(owner, group.id, member);
	await expect(
		service.listMessages(member, group.id, 50),
	).rejects.toMatchObject({ status: 403 });
	await service.sendMessage(owner, group.id, { text: "Only owner" });
	expect(notifications.events.at(-1)!.userIds).toEqual([owner]);
	expect((await repository.getMember(group.id, owner))?.role).toBe("owner");
	await expect(service.joinGroup(member, "unknown")).rejects.toMatchObject({
		status: 404,
	});
});

test("forwarding checks both conversations and preserves original sender across forwards", async () => {
	const { service, owner, member, outsider } = fixture();
	const original = await service.sendPrivate(owner, member, {
		text: "Forward me",
	});
	const destination = await service.createPrivate(member, outsider);
	await expect(
		service.forwardMessage(outsider, destination.id, original.id),
	).rejects.toMatchObject({ status: 403 });
	const forwarded = await service.forwardMessage(
		member,
		destination.id,
		original.id,
	);
	expect(forwarded.text).toBe(original.text);
	expect(forwarded.senderId).toBe(member);
	expect(forwarded.forwardedFrom).toMatchObject({
		messageId: original.id,
		senderId: owner,
	});
	const back = await service.forwardMessage(
		member,
		original.conversationId,
		forwarded.id,
	);
	expect(back.forwardedFrom).toEqual(forwarded.forwardedFrom);
});

test("attachments are scoped to uploader and conversation; forwarded files remain downloadable", async () => {
	const { service, owner, member, outsider } = fixture();
	const source = await service.createPrivate(owner, member);
	const destination = await service.createPrivate(member, outsider);
	const media = await service.uploadAttachment(owner, source.id, {
		buffer: Buffer.from("document bytes"),
		originalname: "notes.txt",
		mimetype: "text/plain",
	});
	expect(media.type).toBe("document");
	await expect(
		service.sendMessage(member, source.id, {
			attachment: { type: "document", mediaId: media.id },
		}),
	).rejects.toMatchObject({ status: 403 });
	await expect(
		service.sendMessage(owner, source.id, {
			attachment: { type: "video", mediaId: media.id },
		}),
	).rejects.toMatchObject({ status: 400 });
	const message = await service.sendMessage(owner, source.id, {
		attachment: { type: "document", mediaId: media.id },
	});
	const forwarded = await service.forwardMessage(
		member,
		destination.id,
		message.id,
	);
	const attachment = forwarded.attachment!;
	if (attachment.type === "gif") throw new Error("Expected a file attachment");
	expect(
		(
			await service.downloadAttachment(
				outsider,
				destination.id,
				attachment.mediaId,
			)
		).body,
	).toEqual(Buffer.from("document bytes"));
	await expect(
		service.downloadAttachment(outsider, source.id, media.id),
	).rejects.toMatchObject({ status: 403 });
});

test("GIF attachments contain only a GIF ID, which must exist", async () => {
	const { service, repository, owner, member } = fixture();
	const chat = await service.createPrivate(owner, member);
	const gifId = randomUUID();
	await expect(
		service.sendMessage(owner, chat.id, { attachment: { type: "gif", gifId } }),
	).rejects.toMatchObject({ status: 404 });
	repository.gifs.add(gifId);
	const message = await service.sendMessage(owner, chat.id, {
		attachment: { type: "gif", gifId },
	});
	expect(message.attachment).toEqual({ type: "gif", gifId });
});

test("reactions use predefined emojis, are idempotent, and can only be removed by their user", async () => {
	const { service, owner, member, outsider } = fixture();
	const message = await service.sendPrivate(owner, member, { text: "React" });
	await service.react(owner, message.conversationId, message.id, "👍");
	await service.react(owner, message.conversationId, message.id, "👍");
	await service.react(member, message.conversationId, message.id, "👍");
	await service.react(member, message.conversationId, message.id, "👍", true);
	const page = await service.listMessages(owner, message.conversationId, 50);
	expect(page.messages[0].reactions).toEqual([
		{ messageId: message.id, userId: owner, emoji: "👍" },
	]);
	await expect(
		service.react(outsider, message.conversationId, message.id, "👍"),
	).rejects.toMatchObject({ status: 403 });
	await expect(
		service.react(owner, message.conversationId, message.id, "custom" as never),
	).rejects.toMatchObject({ status: 400 });
});

test("history pagination uses a stable cursor even when timestamps tie", async () => {
	const { service, repository, owner, member } = fixture();
	const chat = await service.createPrivate(owner, member);
	for (let count = 0; count < 5; count++) {
		const message = await service.sendMessage(owner, chat.id, {
			text: String(count),
		});
		repository.messages.set(message.id, { ...message, createdAt: new Date(0) });
	}
	const first = await service.listMessages(owner, chat.id, 3);
	const second = await service.listMessages(
		owner,
		chat.id,
		3,
		first.nextCursor!,
	);
	expect(first.messages).toHaveLength(3);
	expect(second.messages).toHaveLength(2);
	expect(
		new Set(
			[...first.messages, ...second.messages].map((message) => message.id),
		).size,
	).toBe(5);
	expect(second.nextCursor).toBeNull();
});

test("all attachment types are stored with their type and only members can upload", async () => {
	const { repository, storage, notifications, owner, member, outsider } =
		fixture();
	const service = new ConversationService(
		repository,
		storage,
		notifications,
		{
			async read() {
				return { width: 640, height: 360 };
			},
		},
		{
			async generate() {
				return Buffer.from("jpeg");
			},
		},
	);
	const chat = await service.createPrivate(owner, member);
	const inputs = [
		{ mimetype: "image/png", type: "image" },
		{ mimetype: "video/webm", type: "video" },
		{ mimetype: "audio/ogg", type: "audio" },
		{ mimetype: "audio/mpeg", type: "music", kind: "music" as const },
		{ mimetype: "application/pdf", type: "document" },
	];
	for (const input of inputs) {
		const media = await service.uploadAttachment(
			owner,
			chat.id,
			{
				buffer: Buffer.from("file bytes"),
				originalname: "file",
				mimetype: input.mimetype,
			},
			input.kind,
		);
		expect(media.type).toBe(input.type);
		expect(media.thumbnailUrl).toEqual(
			input.type === "video" ? expect.any(String) : null,
		);
		expect(media).toMatchObject(
			input.type === "image" || input.type === "video"
				? { width: 640, height: 360 }
				: { width: null, height: null },
		);
	}
	expect(storage.objects.size).toBe(6);
	await expect(
		service.uploadAttachment(outsider, chat.id, {
			buffer: Buffer.from("secret"),
			originalname: "file",
			mimetype: "image/png",
		}),
	).rejects.toMatchObject({ status: 403 });
	expect(storage.objects.size).toBe(6);
});

test("private chats reject self-messaging and nonexistent recipients", async () => {
	const { service, owner } = fixture();
	await expect(service.createPrivate(owner, owner)).rejects.toMatchObject({
		status: 400,
	});
	await expect(
		service.createPrivate(owner, randomUUID()),
	).rejects.toMatchObject({ status: 404 });
});

test("username lookups are case-insensitive and reuse chats created by ID, including after a rename", async () => {
	const { service, repository, owner, member } = fixture();
	repository.usernames.set("some_user123", member);
	const byId = await service.createPrivate(owner, member);
	const byName = await service.createPrivateByUsername(owner, "Some_User123");
	expect(byName.id).toBe(byId.id);
	const message = await service.sendPrivateByUsername(owner, "SOME_USER123", {
		text: "Hello",
	});
	expect(message.conversationId).toBe(byId.id);
	repository.usernames.delete("some_user123");
	repository.usernames.set("renamed", member);
	expect((await service.createPrivateByUsername(owner, "Renamed")).id).toBe(
		byId.id,
	);
	await expect(
		service.createPrivateByUsername(owner, "some_user123"),
	).rejects.toMatchObject({ status: 404 });
});

test("username recipients reject self-chats, unknown users, and invalid names", async () => {
	const { service, repository, owner } = fixture();
	repository.usernames.set("me", owner);
	await expect(
		service.createPrivateByUsername(owner, "ME"),
	).rejects.toMatchObject({ status: 400 });
	await expect(
		service.createPrivateByUsername(owner, "unknown"),
	).rejects.toMatchObject({ status: 404 });
	await expect(
		service.createPrivateByUsername(owner, "not-a-username"),
	).rejects.toMatchObject({ status: 400 });
});

test("private replies persist their target in history, single-message lookups, and notifications", async () => {
	const { service, owner, member, outsider, notifications } = fixture();
	const original = await service.sendPrivate(owner, member, {
		text: "Question",
	});
	const reply = await service.sendPrivate(member, owner, {
		text: "Answer",
		replyToMessageId: original.id,
	});
	expect(original.replyToMessageId).toBeNull();
	expect(reply.replyToMessageId).toBe(original.id);
	expect(
		(await service.getMessage(owner, original.conversationId, reply.id))
			.replyToMessageId,
	).toBe(original.id);
	expect(
		(await service.listMessages(owner, original.conversationId, 50)).messages,
	).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ id: reply.id, replyToMessageId: original.id }),
		]),
	);
	expect(notifications.events.at(-1)!.payload).toEqual({ message: reply });
	await expect(
		service.getMessage(outsider, original.conversationId, original.id),
	).rejects.toMatchObject({ status: 403 });
});

test("group members can reply with attachments and reply to replies", async () => {
	const { service, repository, owner, member } = fixture();
	const group = await service.createGroup(owner, "Group");
	await service.addMember(owner, group.id, member);
	const original = await service.sendMessage(owner, group.id, {
		text: "Question",
	});
	const gifId = randomUUID();
	repository.gifs.add(gifId);
	const reply = await service.sendMessage(member, group.id, {
		replyToMessageId: original.id,
		attachment: { type: "gif", gifId },
	});
	expect(reply).toMatchObject({
		replyToMessageId: original.id,
		text: null,
		attachment: { type: "gif", gifId },
	});
	const nested = await service.sendMessage(owner, group.id, {
		text: "Thanks",
		replyToMessageId: reply.id,
	});
	expect(nested.replyToMessageId).toBe(reply.id);
});

test("reply targets must exist in the same chat even if the sender belongs to both", async () => {
	const { service, repository, notifications, owner, member, outsider } =
		fixture();
	const original = await service.sendPrivate(owner, member, {
		text: "Private question",
	});
	const other = await service.createPrivate(owner, outsider);
	const eventCount = notifications.events.length;
	await expect(
		service.sendMessage(owner, other.id, {
			text: "Cross-chat reply",
			replyToMessageId: original.id,
		}),
	).rejects.toMatchObject({ status: 400 });
	await expect(
		service.sendMessage(owner, other.id, {
			text: "Missing reply",
			replyToMessageId: randomUUID(),
		}),
	).rejects.toMatchObject({ status: 400 });
	await expect(
		service.sendMessage(owner, other.id, {
			text: "Invalid reply",
			replyToMessageId: "invalid",
		}),
	).rejects.toMatchObject({ status: 400 });
	await expect(
		service.sendMessage(owner, original.conversationId, {
			replyToMessageId: original.id,
		}),
	).rejects.toMatchObject({ status: 400 });
	expect(repository.messages.size).toBe(1);
	expect(notifications.events).toHaveLength(eventCount);
	await expect(
		service.getMessage(owner, other.id, original.id),
	).rejects.toMatchObject({ status: 404 });
});

test("forwarding a reply does not copy a reference to the original chat", async () => {
	const { service, owner, member, outsider } = fixture();
	const original = await service.sendPrivate(owner, member, {
		text: "Question",
	});
	const reply = await service.sendPrivate(member, owner, {
		text: "Answer",
		replyToMessageId: original.id,
	});
	const destination = await service.createPrivate(member, outsider);
	const forwarded = await service.forwardMessage(
		member,
		destination.id,
		reply.id,
	);
	expect(forwarded.text).toBe("Answer");
	expect(forwarded.replyToMessageId).toBeNull();
	expect(forwarded.forwardedFrom?.messageId).toBe(reply.id);
});

test("message context returns the nearest 50 on each side in chronological order, including timestamp ties", async () => {
	const { service, repository, owner, member } = fixture();
	const chat = await service.createPrivate(owner, member);
	const records = [];
	for (let count = 0; count < 105; count++) {
		const message = {
			id: `00000000-0000-4000-8000-${String(count).padStart(12, "0")}`,
			conversationId: chat.id,
			senderId: owner,
			text: String(count),
			replyToMessageId: null,
			attachment: null,
			forwardedFrom: null,
			createdAt: new Date(0),
		};
		repository.messages.set(message.id, message);
		records.push(message);
	}
	await service.react(member, chat.id, records[51].id, "👍");
	await service.react(member, chat.id, records[52].id, "❤️");
	await service.react(member, chat.id, records[53].id, "🔥");
	const context = await service.getMessagesAround(
		owner,
		chat.id,
		records[52].id,
	);
	expect(context.message.id).toBe(records[52].id);
	expect(context.before.map((message) => message.id)).toEqual(
		records.slice(2, 52).map((message) => message.id),
	);
	expect(context.after.map((message) => message.id)).toEqual(
		records.slice(53, 103).map((message) => message.id),
	);
	expect(context.hasMoreBefore).toBe(true);
	expect(context.hasMoreAfter).toBe(true);
	expect(context.before.at(-1)!.reactions[0].emoji).toBe("👍");
	expect(context.message.reactions[0].emoji).toBe("❤️");
	expect(context.after[0].reactions[0].emoji).toBe("🔥");
	const first = await service.getMessagesAround(
		owner,
		chat.id,
		records[0].id,
		2,
		3,
	);
	expect(first.before).toEqual([]);
	expect(first.hasMoreBefore).toBe(false);
	expect(first.after.map((message) => message.id)).toEqual(
		records.slice(1, 4).map((message) => message.id),
	);
	const last = await service.getMessagesAround(
		owner,
		chat.id,
		records[104].id,
		2,
		3,
	);
	expect(last.before.map((message) => message.id)).toEqual(
		records.slice(102, 104).map((message) => message.id),
	);
	expect(last.after).toEqual([]);
	expect(last.hasMoreAfter).toBe(false);
	const anchorOnly = await service.getMessagesAround(
		owner,
		chat.id,
		records[52].id,
		0,
		0,
	);
	expect(anchorOnly.before).toEqual([]);
	expect(anchorOnly.after).toEqual([]);
	expect(anchorOnly.hasMoreBefore).toBe(true);
	expect(anchorOnly.hasMoreAfter).toBe(true);
});

test("message context requires membership and an anchor in the requested conversation", async () => {
	const { service, owner, member, outsider } = fixture();
	const original = await service.sendPrivate(owner, member, {
		text: "Private",
	});
	const other = await service.createPrivate(owner, outsider);
	await expect(
		service.getMessagesAround(outsider, original.conversationId, original.id),
	).rejects.toMatchObject({ status: 403 });
	await expect(
		service.getMessagesAround(owner, other.id, original.id),
	).rejects.toMatchObject({ status: 404 });
	await expect(
		service.getMessagesAround(owner, other.id, randomUUID()),
	).rejects.toMatchObject({ status: 404 });
	await expect(
		service.getMessagesAround(owner, other.id, original.id, 101),
	).rejects.toMatchObject({ status: 400 });
	const alone = await service.getMessagesAround(
		member,
		original.conversationId,
		original.id,
	);
	expect(alone.before).toEqual([]);
	expect(alone.after).toEqual([]);
	expect(alone.hasMoreBefore).toBe(false);
	expect(alone.hasMoreAfter).toBe(false);
});

test("image dimensions survive forwarding and invalid visual uploads are never stored", async () => {
	const { service, storage, owner, member, outsider } = fixture();
	const source = await service.createPrivate(owner, member);
	const target = await service.createPrivate(owner, outsider);
	const image = await sharp({
		create: { width: 48, height: 32, channels: 3, background: "red" },
	})
		.png()
		.toBuffer();
	const media = await service.uploadAttachment(owner, source.id, {
		buffer: image,
		mimetype: "image/png",
		originalname: "image.png",
	});
	const message = await service.sendMessage(owner, source.id, {
		attachment: { type: "image", mediaId: media.id },
	});
	const forwarded = await service.forwardMessage(owner, target.id, message.id);
	if (forwarded.attachment?.type !== "image") throw new Error("Expected image");
	const copied = await service.getAttachment(
		outsider,
		target.id,
		forwarded.attachment.mediaId,
	);
	expect(copied).toMatchObject({
		width: 48,
		height: 32,
		objectKey: media.objectKey,
	});
	for (const mimetype of ["image/png", "video/mp4"]) {
		await expect(
			service.uploadAttachment(owner, source.id, {
				buffer: Buffer.from("invalid"),
				mimetype,
				originalname: "bad",
			}),
		).rejects.toMatchObject({ status: 400 });
	}
	expect(storage.objects.size).toBe(1);
});

test.each(["generation", "storage", "database"])(
	"video upload fails without saving incomplete records after %s errors",
	async (stage) => {
		const { repository, storage, notifications, owner, member } = fixture();
		const generate = jest.fn(async () => Buffer.from("jpeg"));
		const service = new ConversationService(
			repository,
			storage,
			notifications,
			{
				async read() {
					return { width: 80, height: 40 };
				},
			},
			{ generate },
		);
		const chat = await service.createPrivate(owner, member);
		if (stage === "generation")
			generate.mockRejectedValueOnce(new Error("Generation failed"));
		if (stage === "storage")
			jest.spyOn(storage, "putObject").mockImplementation(async (input) => {
				storage.objects.set(input.key, input.body);
				if (input.key.startsWith("thumbnails/"))
					throw new Error("Storage failed");
			});
		if (stage === "database")
			jest
				.spyOn(repository, "createMedia")
				.mockRejectedValueOnce(new Error("Database failed"));
		await expect(
			service.uploadAttachment(owner, chat.id, {
				buffer: Buffer.from("video"),
				mimetype: "video/mp4",
				originalname: "video.mp4",
			}),
		).rejects.toThrow();
		expect(repository.media.size).toBe(0);
		expect(storage.objects.size).toBe(0);
	},
);

test("video thumbnails survive forwarding, refresh URLs, and do not block downloads if signing fails", async () => {
	const { repository, storage, notifications, owner, member, outsider } =
		fixture();
	const service = new ConversationService(
		repository,
		storage,
		notifications,
		{
			async read() {
				return { width: 80, height: 40 };
			},
		},
		{
			async generate() {
				return Buffer.from("jpeg");
			},
		},
	);
	const source = await service.createPrivate(owner, member);
	const target = await service.createPrivate(owner, outsider);
	const media = await service.uploadAttachment(owner, source.id, {
		buffer: Buffer.from("video"),
		mimetype: "video/mp4",
		originalname: "video.mp4",
	});
	expect(storage.objects.get(media.thumbnailKey!)).toEqual(Buffer.from("jpeg"));
	const message = await service.sendMessage(owner, source.id, {
		attachment: { type: "video", mediaId: media.id },
	});
	const forwarded = await service.forwardMessage(owner, target.id, message.id);
	if (forwarded.attachment?.type !== "video") throw new Error("Expected video");
	const signer = jest
		.spyOn(storage, "getThumbnailUrl")
		.mockResolvedValueOnce("https://storage.example/first")
		.mockResolvedValueOnce("https://storage.example/refreshed");
	expect(
		(
			await service.getAttachment(
				outsider,
				target.id,
				forwarded.attachment.mediaId,
			)
		).thumbnailUrl,
	).toBe("https://storage.example/first");
	expect(
		(
			await service.getAttachment(
				outsider,
				target.id,
				forwarded.attachment.mediaId,
			)
		).thumbnailUrl,
	).toBe("https://storage.example/refreshed");
	expect(signer).toHaveBeenCalledWith(media.thumbnailKey!);
	expect(await repository.getMedia(forwarded.attachment.mediaId)).toMatchObject(
		{ thumbnailKey: media.thumbnailKey },
	);
	expect(await repository.getMedia(media.id)).not.toHaveProperty(
		"thumbnailUrl",
	);
	signer.mockRejectedValue(new Error("Signing unavailable"));
	expect(
		(
			await service.downloadAttachment(
				outsider,
				target.id,
				forwarded.attachment.mediaId,
			)
		).body,
	).toEqual(Buffer.from("video"));
	expect(storage.objects.size).toBe(2);
});
