import { expect, jest, test } from "@jest/globals";
import { randomUUID } from "node:crypto";
import { ConversationService } from "./conversation.service.js";
import {
	MemoryChatStorage,
	MemoryConversationRepository,
	MemoryNotifications,
} from "./conversation.test-support.js";

async function fixture(type: "private" | "group" = "private") {
	const repository = new MemoryConversationRepository();
	const notifications = new MemoryNotifications();
	const service = new ConversationService(
		repository,
		new MemoryChatStorage(),
		notifications,
	);
	const owner = randomUUID(),
		member = randomUUID(),
		outsider = randomUUID();
	for (const userId of [owner, member, outsider]) repository.users.add(userId);
	const chat =
		type === "private"
			? await service.createPrivate(owner, member)
			: await service.createGroup(owner, "Seen group");
	if (type === "group") await service.addMember(owner, chat.id, member);
	function message(
		index: number,
		time: number,
		senderId = member,
		conversationId = chat.id,
	) {
		const id = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
		repository.messages.set(id, {
			id,
			conversationId,
			senderId,
			text: "Hello",
			isEdited: false,
			attachment: null,
			replyToMessageId: null,
			forwardedFrom: null,
			createdAt: new Date(time),
		});
		return id;
	}
	notifications.events.length = 0;
	return {
		repository,
		service,
		notifications,
		owner,
		member,
		outsider,
		chat,
		message,
	};
}

test.each(["private", "group"] as const)(
	"%s seen positions are independent, ordered, and only advance explicitly",
	async (type) => {
		const {
			repository,
			service,
			notifications,
			owner,
			member,
			outsider,
			chat,
			message,
		} = await fixture(type);
		expect((await service.listConversations(owner))[0]).toMatchObject({
			lastSeenMessageId: null,
			unreadCount: 0,
		});
		const first = message(1, 1000, owner);
		const second = message(2, 2000);
		message(3, 2000); // Same timestamp: UUID ordering breaks the tie.
		const fourth = message(4, 3000, owner);
		await service.listMessages(owner, chat.id, 50);
		expect((await service.listConversations(owner))[0]).toMatchObject({
			lastSeenMessageId: null,
			unreadCount: 4,
		});
		expect(
			await service.markSeen(owner, chat.id, { messageId: second }),
		).toEqual({ lastSeenMessageId: second, unreadCount: 2 });
		expect((await service.listConversations(member))[0]).toMatchObject({
			lastSeenMessageId: null,
			unreadCount: 4,
		});
		expect(
			(await service.listMembers(member, chat.id)).find(
				(item) => item.userId === owner,
			)?.lastSeenMessageId,
		).toBe(second);
		expect(notifications.events).toEqual([
			{
				userIds: [member],
				event: "conversation.seen",
				payload: {
					userId: owner,
					conversationId: chat.id,
					lastSeenMessageId: second,
				},
			},
		]);
		for (const messageId of [second, first])
			expect(await service.markSeen(owner, chat.id, { messageId })).toEqual({
				lastSeenMessageId: second,
				unreadCount: 2,
			});
		expect(notifications.events).toHaveLength(1);
		expect(
			await service.markSeen(owner, chat.id, { messageId: fourth }),
		).toEqual({ lastSeenMessageId: fourth, unreadCount: 0 });
		message(5, 4000);
		expect((await service.listConversations(owner))[0].unreadCount).toBe(1);
		expect(await service.listConversations(outsider)).toEqual([]);
		expect(
			(await repository.getMember(chat.id, owner))?.lastSeenMessageId,
		).toBe(fourth);
	},
);

test("seen updates reject outsiders, cross-chat messages, invalid IDs, and failed persistence without notifications", async () => {
	const {
		repository,
		service,
		notifications,
		owner,
		member,
		outsider,
		chat,
		message,
	} = await fixture();
	const target = message(1, 1000);
	const other = await service.createPrivate(owner, outsider);
	const foreign = message(2, 2000, outsider, other.id);
	await expect(
		service.markSeen(outsider, chat.id, { messageId: target }),
	).rejects.toMatchObject({ status: 403 });
	for (const messageId of [foreign, randomUUID(), "invalid"])
		await expect(
			service.markSeen(owner, chat.id, { messageId }),
		).rejects.toMatchObject({ status: 400 });
	jest
		.spyOn(repository, "markSeen")
		.mockRejectedValueOnce(new Error("Database unavailable"));
	await expect(
		service.markSeen(owner, chat.id, { messageId: target }),
	).rejects.toThrow("Database unavailable");
	expect(notifications.events).toHaveLength(0);
	expect(
		(await repository.getMember(chat.id, member))?.lastSeenMessageId,
	).toBeNull();
	jest.spyOn(repository, "markSeen").mockResolvedValueOnce(undefined);
	await expect(
		service.markSeen(owner, chat.id, { messageId: target }),
	).rejects.toMatchObject({ status: 403 });
	expect(notifications.events).toHaveLength(0);
});

test("removed group members lose their seen state, access, and notifications", async () => {
	const {
		repository,
		service,
		notifications,
		owner,
		member,
		outsider,
		chat,
		message,
	} = await fixture("group");
	await service.addMember(owner, chat.id, outsider);
	const first = message(1, 1000);
	const second = message(2, 2000);
	await service.markSeen(member, chat.id, { messageId: first });
	await service.removeMember(owner, chat.id, member);
	expect(await repository.getMember(chat.id, member)).toBeUndefined();
	await expect(
		service.markSeen(member, chat.id, { messageId: second }),
	).rejects.toMatchObject({ status: 403 });
	notifications.events.length = 0;
	await service.markSeen(owner, chat.id, { messageId: second });
	expect(notifications.events[0].userIds).toEqual([outsider]);
	await service.addMember(owner, chat.id, member);
	expect((await service.listConversations(member))[0]).toMatchObject({
		lastSeenMessageId: null,
		unreadCount: 2,
	});
	await service.deleteGroup(owner, chat.id);
	expect(await repository.getMember(chat.id, owner)).toBeUndefined();
});
