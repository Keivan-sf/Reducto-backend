import sharp from "sharp";
import { voiceTestWav } from "../../lib/voice-converter.test-support.js";
import { expect, jest, test } from "@jest/globals";
import { randomUUID } from "node:crypto";
import { ConversationService } from "./conversation.service.js";
import {
	MemoryChatStorage,
	MemoryConversationRepository,
	MemoryNotifications,
} from "./conversation.test-support.js";

const fakeDuration = {
	async read() {
		return 1.25;
	},
};

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

test("attachment metadata accompanies messages across reads, forwards, and notifications", async () => {
	const {
		service,
		repository,
		storage,
		notifications,
		owner,
		member,
		outsider,
	} = fixture();
	const chat = await service.createPrivate(owner, member);
	const media = await repository.createMedia({
		conversationId: chat.id,
		uploaderId: owner,
		type: "video",
		objectKey: "attachments/clip.mp4",
		thumbnailKey: "thumbnails/clip.jpg",
		fileName: "clip.mp4",
		contentType: "video/mp4",
		fileSize: 123,
		width: 64,
		height: 48,
		durationSeconds: 1.25,
	});
	const sent = await service.sendMessage(owner, chat.id, {
		attachment: { type: "video", mediaId: media.id },
	});
	const metadata = {
		...media,
		thumbnailUrl: await storage.getThumbnailUrl(media.thumbnailKey!),
	};
	expect(sent.attachmentMetadata).toEqual(metadata);
	expect(notifications.events.at(-1)?.payload).toMatchObject({
		message: { attachmentMetadata: metadata },
	});
	expect(
		(await service.listMessages(member, chat.id, 10)).messages[0]
			.attachmentMetadata,
	).toEqual(metadata);
	expect(
		(await service.getMessage(member, chat.id, sent.id)).attachmentMetadata,
	).toEqual(metadata);
	expect(
		(await service.getFirstMessage(member, chat.id))?.attachmentMetadata,
	).toEqual(metadata);
	expect(
		(await service.getMessagesAround(member, chat.id, sent.id)).message
			.attachmentMetadata,
	).toEqual(metadata);
	const destination = await service.createPrivate(member, outsider);
	const forwarded = await service.forwardMessage(
		member,
		destination.id,
		sent.id,
	);
	if (forwarded.attachment?.type !== "video")
		throw new Error("Expected a forwarded video");
	expect(forwarded.attachmentMetadata).toMatchObject({
		id: forwarded.attachment.mediaId,
		fileName: media.fileName,
		width: media.width,
		thumbnailUrl: metadata.thumbnailUrl,
	});
	expect(
		(await service.listMessages(outsider, destination.id, 10)).messages[0]
			.attachmentMetadata,
	).toEqual(forwarded.attachmentMetadata);
	const plain = await service.sendMessage(owner, chat.id, { text: "plain" });
	expect(plain.attachmentMetadata).toBeNull();
});

test("GIF message metadata includes playable and thumbnail URLs", async () => {
	const { service, repository, storage, owner, member } = fixture();
	const chat = await service.createPrivate(owner, member);
	const gifId = randomUUID();
	const gif = {
		id: gifId,
		userId: owner,
		objectKey: "gifs/clip.mp4",
		thumbnailKey: "thumbnails/gifs/clip.jpg",
		fileSize: 90,
		width: 32,
		height: 24,
		createdAt: new Date(),
	};
	repository.gifs.add(gifId);
	repository.gifRecords.set(gifId, gif);
	const sent = await service.sendMessage(owner, chat.id, {
		attachment: { type: "gif", gifId },
	});
	expect(sent.attachmentMetadata).toEqual({
		...gif,
		playbackUrl: await storage.getPlaybackUrl(gif.objectKey),
		thumbnailUrl: await storage.getThumbnailUrl(gif.thumbnailKey),
	});
	expect(
		(await service.listMessages(member, chat.id, 10)).messages[0]
			.attachmentMetadata,
	).toEqual(sent.attachmentMetadata);
});

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
		undefined,
		fakeDuration,
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
		expect(media.durationSeconds).toBe(
			input.type === "video" || input.type === "music" ? 1.25 : null,
		);
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
			undefined,
			fakeDuration,
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
		undefined,
		fakeDuration,
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

test.each([
	"audio/ogg",
	"audio/mpeg",
	"audio/mp3",
	"audio/mp4",
	"audio/webm",
	"audio/wav",
	"audio/flac",
	"audio/ogg;codecs=opus",
	"application/ogg",
])("voice uploads accept %s and store converted metadata", async (mimetype) => {
	const { repository, storage, notifications, owner, member, outsider } =
		fixture();
	const converted = Buffer.from("converted ogg opus");
	const convertToOgg = jest.fn(async (_input: Buffer) => converted);
	const service = new ConversationService(
		repository,
		storage,
		notifications,
		undefined,
		undefined,
		{ convertToOgg },
		fakeDuration,
	);
	const chat = await service.createPrivate(owner, member);
	const file = {
		buffer: Buffer.from("source audio"),
		mimetype,
		originalname: "recording.webm",
	};
	const media = await service.uploadAttachment(owner, chat.id, file, "voice");
	expect(media).toMatchObject({
		type: "voice",
		contentType: "audio/ogg",
		fileName: "recording.ogg",
		fileSize: converted.length,
		width: null,
		height: null,
		thumbnailKey: null,
		thumbnailUrl: null,
	});
	expect(media.objectKey).toMatch(/\.ogg$/);
	expect(storage.objects.get(media.objectKey)).toEqual(converted);
	expect(convertToOgg).toHaveBeenCalledWith(file.buffer);
	const message = await service.sendMessage(owner, chat.id, {
		attachment: { type: "voice", mediaId: media.id },
	});
	expect(notifications.events.at(-1)?.payload).toMatchObject({
		message: { attachment: { type: "voice", mediaId: media.id } },
	});
	const target = await service.createPrivate(owner, outsider);
	const forwarded = await service.forwardMessage(owner, target.id, message.id);
	if (forwarded.attachment?.type !== "voice")
		throw new Error("Expected a voice attachment");
	expect(
		(
			await service.getAttachment(
				outsider,
				target.id,
				forwarded.attachment.mediaId,
			)
		).contentType,
	).toBe("audio/ogg");
	expect(
		(
			await service.downloadAttachment(
				outsider,
				target.id,
				forwarded.attachment.mediaId,
			)
		).body,
	).toEqual(converted);
	await expect(
		service.sendMessage(owner, chat.id, {
			attachment: { type: "music", mediaId: media.id },
		}),
	).rejects.toMatchObject({ status: 400 });
});

test("music and ordinary audio preserve their original bytes and do not invoke voice conversion", async () => {
	const { repository, storage, notifications, owner, member } = fixture();
	const convertToOgg = jest.fn(async (_input: Buffer) =>
		Buffer.from("converted"),
	);
	const service = new ConversationService(
		repository,
		storage,
		notifications,
		undefined,
		undefined,
		{ convertToOgg },
		fakeDuration,
	);
	const chat = await service.createPrivate(owner, member);
	const file = {
		buffer: Buffer.from("original mp3"),
		mimetype: "audio/mpeg",
		originalname: "song.mp3",
	};
	for (const kind of [undefined, "music"] as const) {
		const media = await service.uploadAttachment(owner, chat.id, file, kind);
		expect(media).toMatchObject({
			type: kind ?? "audio",
			contentType: "audio/mpeg",
			fileName: "song.mp3",
			fileSize: file.buffer.length,
		});
		expect(storage.objects.get(media.objectKey)).toEqual(file.buffer);
	}
	expect(convertToOgg).not.toHaveBeenCalled();
});

test("music duration is stored and included in message and forwarded metadata", async () => {
	const { service, owner, member, outsider } = fixture();
	const source = await service.createPrivate(owner, member);
	const target = await service.createPrivate(member, outsider);
	const media = await service.uploadAttachment(
		owner,
		source.id,
		{
			buffer: voiceTestWav(2),
			mimetype: "audio/wav",
			originalname: "song.wav",
		},
		"music",
	);
	expect(media.durationSeconds).toBeCloseTo(2, 1);
	const message = await service.sendMessage(owner, source.id, {
		attachment: { type: "music", mediaId: media.id },
	});
	expect(message.attachmentMetadata).toMatchObject({
		durationSeconds: media.durationSeconds,
	});
	const forwarded = await service.forwardMessage(member, target.id, message.id);
	expect(forwarded.attachmentMetadata).toMatchObject({
		durationSeconds: media.durationSeconds,
	});
	expect(
		(await service.listMessages(outsider, target.id, 10)).messages[0]
			.attachmentMetadata,
	).toMatchObject({
		durationSeconds: media.durationSeconds,
	});
});

test("voice uploads enforce membership, size limits, valid audio, and clean up failed persistence", async () => {
	const { repository, storage, notifications, owner, member, outsider } =
		fixture();
	const convertToOgg = jest.fn(async (_input: Buffer) => Buffer.from("ogg"));
	const service = new ConversationService(
		repository,
		storage,
		notifications,
		undefined,
		undefined,
		{ convertToOgg },
		fakeDuration,
	);
	const chat = await service.createPrivate(owner, member);
	const file = {
		buffer: Buffer.from("audio"),
		mimetype: "audio/wav",
		originalname: "recording.wav",
	};
	await expect(
		service.uploadAttachment(outsider, chat.id, file, "voice"),
	).rejects.toMatchObject({ status: 403 });
	await expect(
		service.uploadAttachment(
			owner,
			chat.id,
			{ ...file, buffer: Buffer.alloc(0) },
			"voice",
		),
	).rejects.toMatchObject({ status: 400 });
	await expect(
		service.uploadAttachment(
			owner,
			chat.id,
			{ ...file, buffer: Buffer.alloc(50 * 1024 * 1024 + 1) },
			"voice",
		),
	).rejects.toMatchObject({ status: 400 });
	await expect(
		service.uploadAttachment(
			owner,
			chat.id,
			{ ...file, mimetype: "image/png" },
			"voice",
		),
	).rejects.toMatchObject({ status: 400 });
	expect(convertToOgg).not.toHaveBeenCalled();
	convertToOgg.mockRejectedValueOnce(new Error("Invalid audio"));
	await expect(
		service.uploadAttachment(owner, chat.id, file, "voice"),
	).rejects.toThrow("Invalid audio");
	expect(storage.objects.size).toBe(0);
	jest
		.spyOn(repository, "createMedia")
		.mockRejectedValueOnce(new Error("Database unavailable"));
	await expect(
		service.uploadAttachment(owner, chat.id, file, "voice"),
	).rejects.toThrow("Database unavailable");
	expect(storage.objects.size).toBe(0);
	expect(repository.media.size).toBe(0);
});

test.each(["private", "group"] as const)(
	"first-message lookup in a %s conversation uses chronological order and UUID ties",
	async (type) => {
		const { service, repository, notifications, owner, member, outsider } =
			fixture();
		const chat =
			type === "private"
				? await service.createPrivate(owner, member)
				: await service.createGroup(owner, "History");
		if (type === "group") await service.addMember(owner, chat.id, member);
		expect(await service.getFirstMessage(owner, chat.id)).toBeNull();
		const newest = await service.sendMessage(owner, chat.id, {
			text: "Newest",
		});
		const earlyA = await service.sendMessage(member, chat.id, {
			text: "Early A",
		});
		const earlyB = await service.sendMessage(member, chat.id, {
			text: "Early B",
		});
		repository.messages.get(newest.id)!.createdAt = new Date(2000);
		repository.messages.get(earlyA.id)!.createdAt = new Date(1000);
		repository.messages.get(earlyB.id)!.createdAt = new Date(1000);
		const oldest = earlyA.id < earlyB.id ? earlyA : earlyB;
		await service.react(member, chat.id, oldest.id, "👍");
		const other = await service.createPrivate(owner, outsider);
		const unrelated = await service.sendMessage(outsider, other.id, {
			text: "Earlier in another chat",
		});
		repository.messages.get(unrelated.id)!.createdAt = new Date(0);
		const events = notifications.events.length;
		expect(await service.getFirstMessage(member, chat.id)).toMatchObject({
			id: oldest.id,
			reactions: [{ messageId: oldest.id, userId: member, emoji: "👍" }],
		});
		expect(
			(await service.listConversations(member)).find(
				(item) => item.id === chat.id,
			)?.lastSeenMessageId,
		).toBeNull();
		expect(notifications.events).toHaveLength(events);
		await expect(
			service.getFirstMessage(outsider, chat.id),
		).rejects.toMatchObject({ status: 403 });
		if (type === "group") {
			await service.removeMember(owner, chat.id, member);
			await expect(
				service.getFirstMessage(member, chat.id),
			).rejects.toMatchObject({ status: 403 });
		}
	},
);
