import { expect, test } from "@jest/globals";
import { randomUUID } from "node:crypto";
import { mentionedUsernames } from "./conversation.mentions.js";
import { ConversationService } from "./conversation.service.js";
import {
	MemoryChatStorage,
	MemoryConversationRepository,
	MemoryNotifications,
} from "./conversation.test-support.js";

async function fixture() {
	const repository = new MemoryConversationRepository();
	const service = new ConversationService(
		repository,
		new MemoryChatStorage(),
		new MemoryNotifications(),
	);
	const owner = randomUUID(),
		member = randomUUID(),
		outsider = randomUUID();
	for (const id of [owner, member, outsider]) repository.users.add(id);
	repository.usernames.set("owner", owner);
	repository.usernames.set("member_1", member);
	repository.usernames.set("outsider", outsider);
	const group = await service.createGroup(owner, "Mentions");
	await service.addMember(owner, group.id, member);
	return { repository, service, owner, member, outsider, group };
}

test("mention parsing respects boundaries, case, punctuation and username length", () => {
	expect(
		mentionedUsernames(
			`Hi (@Member_1), @MEMBER_1! @owner\n@other user@domain.com @@bad x@no é@no @owneré @${"a".repeat(33)} @${"b".repeat(32)}`,
		),
	).toEqual(["member_1", "owner", "other", "b".repeat(32)]);
	expect(mentionedUsernames(null)).toEqual([]);
});

test("group mentions resolve current members once per message and are returned only to their recipient", async () => {
	const { repository, service, owner, member, outsider, group } =
		await fixture();
	const message = await service.sendMessage(owner, group.id, {
		text: "@Member_1 @member_1 @outsider @missing @owner",
	});
	const mention = {
		userId: member,
		conversationId: group.id,
		messageId: message.id,
		seen: false,
	};
	expect(repository.mentions.size).toBe(2);
	expect(
		(await service.getConversation(member, group.id)).unseenMentions,
	).toEqual([mention]);
	expect((await service.listConversations(member))[0]).toMatchObject({
		lastSeenMessageId: null,
		unseenMentions: [mention],
	});
	expect((await service.listConversations(owner))[0].unseenMentions).toEqual([
		{ ...mention, userId: owner },
	]);
	await expect(
		service.getConversation(outsider, group.id),
	).rejects.toMatchObject({ status: 403 });

	// Membership and usernames are captured at arrival, not when the list is read.
	await service.addMember(owner, group.id, outsider);
	expect(
		(await service.getConversation(outsider, group.id)).unseenMentions,
	).toEqual([]);
	repository.usernames.delete("member_1");
	repository.usernames.set("renamed", member);
	expect(
		(await service.getConversation(member, group.id)).unseenMentions,
	).toEqual([mention]);
	await service.sendMessage(owner, group.id, { text: "@member_1 @renamed" });
	expect(
		(await service.getConversation(member, group.id)).unseenMentions,
	).toHaveLength(2);
});

test("only the recipient can mark a mention seen, idempotently and independently of conversation read state", async () => {
	const { service, owner, member, outsider, group } = await fixture();
	const message = await service.sendMessage(owner, group.id, {
		text: "@member_1",
	});
	await expect(
		service.markMentionSeen(owner, group.id, message.id),
	).rejects.toMatchObject({ status: 404 });
	await expect(
		service.markMentionSeen(outsider, group.id, message.id),
	).rejects.toMatchObject({ status: 403 });
	await expect(
		service.markMentionSeen(member, group.id, randomUUID()),
	).rejects.toMatchObject({ status: 404 });
	const other = await service.createGroup(owner, "Other");
	await service.addMember(owner, other.id, member);
	await expect(
		service.markMentionSeen(member, other.id, message.id),
	).rejects.toMatchObject({ status: 404 });
	await service.markSeen(member, group.id, { messageId: message.id });
	expect(
		(await service.getConversation(member, group.id)).unseenMentions,
	).toHaveLength(1);
	for (let i = 0; i < 2; i++)
		expect(
			await service.markMentionSeen(member, group.id, message.id),
		).toMatchObject({ userId: member, seen: true });
	expect(
		(await service.listConversations(member)).find(
			(chat) => chat.id === group.id,
		)?.unseenMentions,
	).toEqual([]);
	const next = await service.sendMessage(owner, group.id, {
		text: "@member_1",
	});
	await service.markMentionSeen(member, group.id, next.id);
	expect(
		(await service.getConversation(member, group.id)).lastSeenMessageId,
	).toBe(message.id);
});

test("private chats stay unchanged; forwarded text and attachment captions create group mentions, edits do not", async () => {
	const { repository, service, owner, member, group } = await fixture();
	const chat = await service.createPrivate(owner, member);
	const source = await service.sendMessage(owner, chat.id, {
		text: "@member_1",
	});
	expect(repository.mentions.size).toBe(0);
	expect(await service.getConversation(member, chat.id)).not.toHaveProperty(
		"unseenMentions",
	);
	expect(
		(await service.listConversations(member)).find(
			(item) => item.id === chat.id,
		),
	).not.toHaveProperty("unseenMentions");
	await expect(
		service.markMentionSeen(member, chat.id, source.id),
	).rejects.toMatchObject({ status: 400 });
	await service.forwardMessage(owner, group.id, source.id);
	expect(repository.mentions.size).toBe(1);
	const gifId = randomUUID();
	repository.gifs.add(gifId);
	await service.sendMessage(owner, group.id, {
		attachment: { type: "gif", gifId },
	});
	expect(repository.mentions.size).toBe(1);
	const caption = await service.sendMessage(owner, group.id, {
		text: "@member_1",
		attachment: { type: "gif", gifId },
	});
	expect(repository.mentions.size).toBe(2);
	await service.editMessage(owner, group.id, caption.id, { text: "@owner" });
	expect(
		(await service.getConversation(owner, group.id)).unseenMentions,
	).toEqual([]);
	expect(
		(await service.getConversation(member, group.id)).unseenMentions,
	).toHaveLength(2);
});

test("removed members lose mentions; joining again does not restore old mentions", async () => {
	const { repository, service, owner, member, group } = await fixture();
	await service.sendMessage(owner, group.id, { text: "@member_1" });
	await service.removeMember(owner, group.id, member);
	expect(repository.mentions.size).toBe(0);
	await service.sendMessage(owner, group.id, { text: "@member_1" });
	await service.addMember(owner, group.id, member);
	expect(
		(await service.getConversation(member, group.id)).unseenMentions,
	).toEqual([]);
	await service.sendMessage(owner, group.id, { text: "@member_1" });
	await service.deleteGroup(owner, group.id);
	expect(repository.mentions.size).toBe(0);
});
