import { and, asc, desc, eq, gt, inArray, lt, or, sql } from "drizzle-orm";
import type { createDatabase } from "../../db/client.js";
import {
	conversationMedia,
	conversationMembers,
	conversations,
	gifs,
	messageReactions,
	messages,
	users,
} from "../../db/schema.js";
import type {
	Conversation,
	ConversationListItem,
	ReadState,
	Media,
	Member,
	MemberRole,
	Message,
	Reaction,
	ReactionEmoji,
} from "./conversation.types.js";

export interface ConversationRepository {
	userExists(userId: string): Promise<boolean>;
	findUserIdByUsername(username: string): Promise<string | undefined>;
	gifExists(gifId: string): Promise<boolean>;
	createPrivate(userIds: [string, string]): Promise<Conversation>;
	createGroup(
		ownerId: string,
		name: string,
		inviteToken: string,
	): Promise<Conversation>;
	getConversation(id: string): Promise<Conversation | undefined>;
	findByInvite(token: string): Promise<Conversation | undefined>;
	listConversations(userId: string): Promise<ConversationListItem[]>;
	markSeen(
		conversationId: string,
		userId: string,
		messageId: string,
	): Promise<(ReadState & { changed: boolean }) | undefined>;
	getMember(
		conversationId: string,
		userId: string,
	): Promise<Member | undefined>;
	listMembers(conversationId: string): Promise<Member[]>;
	addMember(conversationId: string, userId: string): Promise<void>;
	setRole(
		conversationId: string,
		userId: string,
		role: MemberRole,
	): Promise<void>;
	removeMember(conversationId: string, userId: string): Promise<void>;
	renameGroup(conversationId: string, name: string): Promise<void>;
	deleteGroup(conversationId: string): Promise<void>;
	createMessage(message: Omit<Message, "id" | "createdAt">): Promise<Message>;
	getMessage(id: string): Promise<Message | undefined>;
	listMessages(
		conversationId: string,
		limit: number,
		before?: Message,
	): Promise<Message[]>;
	listMessagesAfter(
		conversationId: string,
		limit: number,
		after: Message,
	): Promise<Message[]>;
	createMedia(media: Omit<Media, "id" | "createdAt">): Promise<Media>;
	getMedia(id: string): Promise<Media | undefined>;
	addReaction(
		messageId: string,
		userId: string,
		emoji: ReactionEmoji,
	): Promise<void>;
	removeReaction(
		messageId: string,
		userId: string,
		emoji: ReactionEmoji,
	): Promise<void>;
	listReactions(messageIds: string[]): Promise<Reaction[]>;
}

type Database = ReturnType<typeof createDatabase>;

// Use PostgreSQL timestamps directly to retain microsecond precision. The tuple
// ordering matches message history and its (conversation_id, created_at, id) index.
// Keep outer references explicitly qualified: single-table Drizzle selections
// otherwise strip column qualifiers, which would change subquery correlation.
const unreadCount = sql<number>`(SELECT count(*) FROM messages AS unread
 WHERE unread.conversation_id = conversation_members.conversation_id
 AND (conversation_members.last_seen_message_id IS NULL OR
 (unread.created_at, unread.id) > (SELECT created_at, id FROM messages
 WHERE id = conversation_members.last_seen_message_id)))`.mapWith(Number);

export class DrizzleConversationRepository implements ConversationRepository {
	constructor(private readonly database: Database) {}

	async findUserIdByUsername(username: string) {
		const [user] = await this.database
			.select({ id: users.id })
			.from(users)
			.where(eq(users.username, username.toLowerCase()))
			.limit(1);
		return user?.id;
	}

	async userExists(userId: string) {
		return Boolean(
			await this.database.query.users.findFirst({
				where: eq(users.id, userId),
			}),
		);
	}

	async gifExists(gifId: string) {
		return Boolean(
			await this.database.query.gifs.findFirst({ where: eq(gifs.id, gifId) }),
		);
	}

	async createPrivate(userIds: [string, string]) {
		const privateKey = [...userIds].sort().join(":");
		return this.database.transaction(async (transaction) => {
			const [conversation] = await transaction
				.insert(conversations)
				.values({ type: "private", privateKey })
				.onConflictDoUpdate({
					target: conversations.privateKey,
					set: { privateKey },
				})
				.returning();
			await transaction
				.insert(conversationMembers)
				.values(
					userIds.map((userId) => ({
						conversationId: conversation.id,
						userId,
					})),
				)
				.onConflictDoNothing();
			return conversation;
		});
	}

	async createGroup(ownerId: string, name: string, inviteToken: string) {
		return this.database.transaction(async (transaction) => {
			const [conversation] = await transaction
				.insert(conversations)
				.values({ type: "group", name, inviteToken })
				.returning();
			await transaction.insert(conversationMembers).values({
				conversationId: conversation.id,
				userId: ownerId,
				role: "owner",
			});
			return conversation;
		});
	}

	getConversation(id: string) {
		return this.database.query.conversations.findFirst({
			where: eq(conversations.id, id),
		});
	}

	findByInvite(token: string) {
		return this.database.query.conversations.findFirst({
			where: eq(conversations.inviteToken, token),
		});
	}

	async listConversations(userId: string) {
		const rows = await this.database
			.select({
				conversation: conversations,
				lastSeenMessageId: conversationMembers.lastSeenMessageId,
				unreadCount,
			})
			.from(conversationMembers)
			.innerJoin(
				conversations,
				eq(conversations.id, conversationMembers.conversationId),
			)
			.where(eq(conversationMembers.userId, userId))
			.orderBy(desc(conversations.createdAt));
		return rows.map((row) => ({
			...row.conversation,
			lastSeenMessageId: row.lastSeenMessageId,
			unreadCount: row.unreadCount,
		}));
	}

	async markSeen(conversationId: string, userId: string, messageId: string) {
		return this.database.transaction(async (transaction) => {
			const memberWhere = and(
				eq(conversationMembers.conversationId, conversationId),
				eq(conversationMembers.userId, userId),
			);
			// Serialize updates from multiple devices for this member.
			const [member] = await transaction
				.select({ userId: conversationMembers.userId })
				.from(conversationMembers)
				.where(memberWhere)
				.for("update");
			if (!member) return undefined;
			const updated = await transaction
				.update(conversationMembers)
				.set({ lastSeenMessageId: messageId })
				.where(
					and(
						memberWhere,
						sql`(${conversationMembers.lastSeenMessageId} IS NULL OR
    (SELECT (created_at, id) FROM messages WHERE id = ${messageId}) >
    (SELECT (created_at, id) FROM messages WHERE id = ${conversationMembers.lastSeenMessageId}))`,
					),
				)
				.returning({ id: conversationMembers.lastSeenMessageId });
			const [state] = await transaction
				.select({
					lastSeenMessageId: conversationMembers.lastSeenMessageId,
					unreadCount,
				})
				.from(conversationMembers)
				.where(memberWhere);
			return { ...state, changed: updated.length > 0 };
		});
	}

	getMember(conversationId: string, userId: string) {
		return this.database.query.conversationMembers.findFirst({
			where: and(
				eq(conversationMembers.conversationId, conversationId),
				eq(conversationMembers.userId, userId),
			),
		});
	}

	listMembers(conversationId: string) {
		return this.database.query.conversationMembers.findMany({
			where: eq(conversationMembers.conversationId, conversationId),
		});
	}

	async addMember(conversationId: string, userId: string) {
		await this.database
			.insert(conversationMembers)
			.values({ conversationId, userId })
			.onConflictDoNothing();
	}

	async setRole(conversationId: string, userId: string, role: MemberRole) {
		await this.database
			.update(conversationMembers)
			.set({ role })
			.where(
				and(
					eq(conversationMembers.conversationId, conversationId),
					eq(conversationMembers.userId, userId),
				),
			);
	}

	async removeMember(conversationId: string, userId: string) {
		await this.database
			.delete(conversationMembers)
			.where(
				and(
					eq(conversationMembers.conversationId, conversationId),
					eq(conversationMembers.userId, userId),
				),
			);
	}

	async renameGroup(conversationId: string, name: string) {
		await this.database
			.update(conversations)
			.set({ name })
			.where(eq(conversations.id, conversationId));
	}

	async deleteGroup(conversationId: string) {
		await this.database
			.delete(conversations)
			.where(eq(conversations.id, conversationId));
	}

	async createMessage(message: Omit<Message, "id" | "createdAt">) {
		const [createdMessage] = await this.database
			.insert(messages)
			.values(message)
			.returning();
		return createdMessage;
	}

	getMessage(id: string) {
		return this.database.query.messages.findFirst({
			where: eq(messages.id, id),
		});
	}

	listMessages(conversationId: string, limit: number, before?: Message) {
		const timestamp = before
			? sql`(select created_at from messages where id = ${before.id})`
			: undefined;
		return this.database.query.messages.findMany({
			where: and(
				eq(messages.conversationId, conversationId),
				before
					? or(
							lt(messages.createdAt, timestamp!),
							and(
								eq(messages.createdAt, timestamp!),
								lt(messages.id, before.id),
							),
						)
					: undefined,
			),
			orderBy: [desc(messages.createdAt), desc(messages.id)],
			limit,
		});
	}

	listMessagesAfter(conversationId: string, limit: number, after: Message) {
		const timestamp = sql`(select created_at from messages where id = ${after.id})`;
		return this.database.query.messages.findMany({
			where: and(
				eq(messages.conversationId, conversationId),
				or(
					gt(messages.createdAt, timestamp),
					and(eq(messages.createdAt, timestamp), gt(messages.id, after.id)),
				),
			),
			orderBy: [asc(messages.createdAt), asc(messages.id)],
			limit,
		});
	}

	async createMedia(media: Omit<Media, "id" | "createdAt">) {
		const [createdMedia] = await this.database
			.insert(conversationMedia)
			.values(media)
			.returning();
		return createdMedia;
	}

	getMedia(id: string) {
		return this.database.query.conversationMedia.findFirst({
			where: eq(conversationMedia.id, id),
		});
	}

	async addReaction(messageId: string, userId: string, emoji: ReactionEmoji) {
		await this.database
			.insert(messageReactions)
			.values({ messageId, userId, emoji })
			.onConflictDoNothing();
	}

	async removeReaction(
		messageId: string,
		userId: string,
		emoji: ReactionEmoji,
	) {
		await this.database
			.delete(messageReactions)
			.where(
				and(
					eq(messageReactions.messageId, messageId),
					eq(messageReactions.userId, userId),
					eq(messageReactions.emoji, emoji),
				),
			);
	}

	async listReactions(messageIds: string[]) {
		if (!messageIds.length) return [];
		return this.database.query.messageReactions.findMany({
			where: inArray(messageReactions.messageId, messageIds),
		});
	}
}
