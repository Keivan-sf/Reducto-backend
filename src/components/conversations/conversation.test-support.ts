import { randomUUID } from "node:crypto";
import type { Notifications } from "../../realtime/notifications.js";
import type { ConversationRepository } from "./conversation.repository.js";
import type { ChatObjectStorage } from "./conversation.service.js";
import type {
	Conversation,
	Media,
	Member,
	MemberRole,
	Message,
	Reaction,
	ReactionEmoji,
} from "./conversation.types.js";

export class MemoryConversationRepository implements ConversationRepository {
	readonly users = new Set<string>();
	readonly usernames = new Map<string, string>();
	readonly gifs = new Set<string>();
	readonly conversations = new Map<string, Conversation>();
	readonly members = new Map<string, Member>();
	readonly messages = new Map<string, Message>();
	readonly media = new Map<string, Media>();
	readonly reactions = new Map<string, Reaction>();

	async userExists(userId: string) {
		return this.users.has(userId);
	}
	async findUserIdByUsername(username: string) {
		return this.usernames.get(username.toLowerCase());
	}
	async gifExists(gifId: string) {
		return this.gifs.has(gifId);
	}
	async createPrivate(userIds: [string, string]) {
		const privateKey = [...userIds].sort().join(":");
		const existing = [...this.conversations.values()].find(
			(conversation) => conversation.privateKey === privateKey,
		);
		if (existing) return existing;
		const conversation: Conversation = {
			id: randomUUID(),
			type: "private",
			name: null,
			privateKey,
			inviteToken: null,
			createdAt: new Date(),
		};
		this.conversations.set(conversation.id, conversation);
		for (const userId of userIds) await this.addMember(conversation.id, userId);
		return conversation;
	}
	async createGroup(ownerId: string, name: string, inviteToken: string) {
		const conversation: Conversation = {
			id: randomUUID(),
			type: "group",
			name,
			privateKey: null,
			inviteToken,
			createdAt: new Date(),
		};
		this.conversations.set(conversation.id, conversation);
		await this.addMember(conversation.id, ownerId);
		await this.setRole(conversation.id, ownerId, "owner");
		return conversation;
	}
	async getConversation(id: string) {
		return this.conversations.get(id);
	}
	async findByInvite(token: string) {
		return [...this.conversations.values()].find(
			(conversation) => conversation.inviteToken === token,
		);
	}
	async listConversations(userId: string) {
		return [...this.conversations.values()]
			.filter((conversation) =>
				this.members.has(`${conversation.id}:${userId}`),
			)
			.map((conversation) => ({
				...conversation,
				...this.readState(conversation.id, userId),
			}));
	}
	private readState(conversationId: string, userId: string) {
		const lastSeenMessageId = this.members.get(
			`${conversationId}:${userId}`,
		)!.lastSeenMessageId;
		const lastSeen = lastSeenMessageId
			? this.messages.get(lastSeenMessageId)
			: undefined;
		const unreadCount = [...this.messages.values()].filter(
			(message) =>
				message.conversationId === conversationId &&
				(!lastSeen || this.newer(message, lastSeen)),
		).length;
		return { lastSeenMessageId, unreadCount };
	}
	private newer(message: Message, previous: Message) {
		return (
			+message.createdAt > +previous.createdAt ||
			(+message.createdAt === +previous.createdAt && message.id > previous.id)
		);
	}
	async markSeen(conversationId: string, userId: string, messageId: string) {
		const member = this.members.get(`${conversationId}:${userId}`);
		if (!member) return undefined;
		const previous = member.lastSeenMessageId
			? this.messages.get(member.lastSeenMessageId)
			: undefined;
		const changed =
			!previous || this.newer(this.messages.get(messageId)!, previous);
		if (changed) member.lastSeenMessageId = messageId;
		return { ...this.readState(conversationId, userId), changed };
	}

	async getMember(conversationId: string, userId: string) {
		return this.members.get(`${conversationId}:${userId}`);
	}
	async listMembers(conversationId: string) {
		return [...this.members.values()].filter(
			(member) => member.conversationId === conversationId,
		);
	}
	async addMember(conversationId: string, userId: string) {
		const key = `${conversationId}:${userId}`;
		if (!this.members.has(key))
			this.members.set(key, {
				conversationId,
				userId,
				role: "member",
				joinedAt: new Date(),
				lastSeenMessageId: null,
			});
	}
	async setRole(conversationId: string, userId: string, role: MemberRole) {
		const member = this.members.get(`${conversationId}:${userId}`);
		if (member)
			this.members.set(`${conversationId}:${userId}`, { ...member, role });
	}
	async removeMember(conversationId: string, userId: string) {
		this.members.delete(`${conversationId}:${userId}`);
	}
	async renameGroup(conversationId: string, name: string) {
		const conversation = this.conversations.get(conversationId)!;
		this.conversations.set(conversationId, { ...conversation, name });
	}
	async deleteGroup(conversationId: string) {
		this.conversations.delete(conversationId);
		for (const [key, member] of this.members)
			if (member.conversationId === conversationId) this.members.delete(key);
		for (const [key, message] of this.messages)
			if (message.conversationId === conversationId) this.messages.delete(key);
		for (const [key, media] of this.media)
			if (media.conversationId === conversationId) this.media.delete(key);
	}
	async createMessage(input: Omit<Message, "id" | "createdAt">) {
		const message = { ...input, id: randomUUID(), createdAt: new Date() };
		this.messages.set(message.id, message);
		return message;
	}
	async getMessage(id: string) {
		return this.messages.get(id);
	}
	async getFirstMessage(conversationId: string) {
		return [...this.messages.values()]
			.filter((message) => message.conversationId === conversationId)
			.sort(
				(first, second) =>
					+first.createdAt - +second.createdAt ||
					(first.id < second.id ? -1 : first.id > second.id ? 1 : 0),
			)[0];
	}
	async listMessages(conversationId: string, limit: number, before?: Message) {
		return [...this.messages.values()]
			.filter(
				(message) =>
					message.conversationId === conversationId &&
					(!before ||
						message.createdAt < before.createdAt ||
						(+message.createdAt === +before.createdAt &&
							message.id < before.id)),
			)
			.sort(
				(first, second) =>
					+second.createdAt - +first.createdAt ||
					(first.id < second.id ? 1 : -1),
			)
			.slice(0, limit);
	}
	async listMessagesAfter(
		conversationId: string,
		limit: number,
		after: Message,
	) {
		return [...this.messages.values()]
			.filter(
				(message) =>
					message.conversationId === conversationId &&
					(message.createdAt > after.createdAt ||
						(+message.createdAt === +after.createdAt && message.id > after.id)),
			)
			.sort(
				(first, second) =>
					+first.createdAt - +second.createdAt ||
					(first.id > second.id ? 1 : -1),
			)
			.slice(0, limit);
	}
	async createMedia(input: Omit<Media, "id" | "createdAt">) {
		const media = { ...input, id: randomUUID(), createdAt: new Date() };
		this.media.set(media.id, media);
		return media;
	}
	async getMedia(id: string) {
		return this.media.get(id);
	}
	async addReaction(messageId: string, userId: string, emoji: ReactionEmoji) {
		this.reactions.set(`${messageId}:${userId}:${emoji}`, {
			messageId,
			userId,
			emoji,
		});
	}
	async removeReaction(
		messageId: string,
		userId: string,
		emoji: ReactionEmoji,
	) {
		this.reactions.delete(`${messageId}:${userId}:${emoji}`);
	}
	async listReactions(messageIds: string[]) {
		return [...this.reactions.values()].filter((reaction) =>
			messageIds.includes(reaction.messageId),
		);
	}
}

export class MemoryChatStorage implements ChatObjectStorage {
	readonly objects = new Map<string, Buffer>();
	async putObject(input: { key: string; body: Buffer }) {
		this.objects.set(input.key, input.body);
	}
	async getThumbnailUrl(key: string) {
		return `https://storage.example/${key}?signed=true`;
	}
	async getObject(key: string) {
		return this.objects.get(key)!;
	}
	async deleteObject(key: string) {
		this.objects.delete(key);
	}
}

export class MemoryNotifications implements Notifications {
	readonly events: { userIds: string[]; event: string; payload: unknown }[] =
		[];
	publish(userIds: string[], event: string, payload: unknown) {
		this.events.push({ userIds, event, payload });
	}
}
