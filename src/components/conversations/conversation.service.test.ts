import { expect, test } from "@jest/globals";
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
	const { service, storage, owner, member, outsider } = fixture();
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
	}
	expect(storage.objects.size).toBe(5);
	await expect(
		service.uploadAttachment(outsider, chat.id, {
			buffer: Buffer.from("secret"),
			originalname: "file",
			mimetype: "image/png",
		}),
	).rejects.toMatchObject({ status: 403 });
	expect(storage.objects.size).toBe(5);
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
