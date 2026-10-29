import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { createDatabase } from "../../db/client.js";
import {
	conversations,
	conversationMembers,
	refreshTokens,
	users,
} from "../../db/schema.js";

import type {
	Conversation,
	Member,
} from "../conversations/conversation.types.js";

export type AuthUser = {
	id: string;
	email: string;
	name: string;
	username: string | null;
	avatarKey: string | null;
	passwordHash: string;
	createdAt: Date;
	lastSeen?: Date | null;
};
export type RefreshSession = {
	id: string;
	userId: string;
	tokenHash: string;
	expiresAt: Date;
};

export interface AuthRepository {
	findUserByEmail(email: string): Promise<AuthUser | undefined>;
	findUserByUsername(username: string): Promise<AuthUser | undefined>;
	findUserById(id: string): Promise<AuthUser | undefined>;
	// Creates the user and their permanent Saved Messages conversation atomically.
	createUser(user: {
		email: string;
		name: string;
		username?: string;
		passwordHash: string;
	}): Promise<AuthUser>;
	createSession(session: RefreshSession): Promise<void>;
	findSession(id: string): Promise<RefreshSession | undefined>;
	deleteSession(id: string): Promise<void>;
}

export function tokenHash(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

export class InMemoryAuthRepository implements AuthRepository {
	constructor(
		private readonly savedMessages: {
			conversations: Map<string, Conversation>;
			members: Map<string, Member>;
		} = { conversations: new Map(), members: new Map() },
	) {}

	private readonly userRecords = new Map<string, AuthUser>();
	private readonly sessionRecords = new Map<string, RefreshSession>();

	async findUserByEmail(email: string) {
		return [...this.userRecords.values()].find((user) => user.email === email);
	}

	async findUserByUsername(username: string) {
		return [...this.userRecords.values()].find(
			(user) => user.username === username,
		);
	}

	async findUserById(id: string) {
		return this.userRecords.get(id);
	}

	async createUser({
		email,
		name,
		username,
		passwordHash,
	}: Parameters<AuthRepository["createUser"]>[0]) {
		const user = {
			id: randomUUID(),
			email,
			name,
			username: username ?? null,
			avatarKey: null,
			passwordHash,
			createdAt: new Date(),
		};
		const conversation: Conversation = {
			id: randomUUID(),
			type: "saved",
			name: "Saved Messages",
			savedMessagesOwnerId: user.id,
			privateKey: null,
			inviteToken: null,
			createdAt: user.createdAt,
		};
		this.savedMessages.conversations.set(conversation.id, conversation);
		this.savedMessages.members.set(`${conversation.id}:${user.id}`, {
			conversationId: conversation.id,
			userId: user.id,
			role: "owner",
			joinedAt: user.createdAt,
			lastSeenMessageId: null,
		});
		this.userRecords.set(user.id, user);
		return user;
	}

	async createSession(session: RefreshSession) {
		this.sessionRecords.set(session.id, session);
	}
	async findSession(id: string) {
		return this.sessionRecords.get(id);
	}
	async deleteSession(id: string) {
		this.sessionRecords.delete(id);
	}
}

type Database = ReturnType<typeof createDatabase>;

export class DrizzleAuthRepository implements AuthRepository {
	constructor(private readonly database: Database) {}

	async findUserByEmail(email: string) {
		return this.database.query.users.findFirst({
			where: eq(users.email, email),
		});
	}

	async findUserByUsername(username: string) {
		return this.database.query.users.findFirst({
			where: eq(users.username, username),
		});
	}

	async findUserById(id: string) {
		return this.database.query.users.findFirst({ where: eq(users.id, id) });
	}

	async createUser(user: Parameters<AuthRepository["createUser"]>[0]) {
		return this.database.transaction(async (transaction) => {
			const [createdUser] = await transaction
				.insert(users)
				.values(user)
				.returning();
			const [conversation] = await transaction
				.insert(conversations)
				.values({
					type: "saved",
					name: "Saved Messages",
					savedMessagesOwnerId: createdUser.id,
				})
				.returning();
			await transaction.insert(conversationMembers).values({
				conversationId: conversation.id,
				userId: createdUser.id,
				role: "owner",
			});
			return createdUser;
		});
	}

	async createSession(session: RefreshSession) {
		await this.database.insert(refreshTokens).values(session);
	}

	async findSession(id: string) {
		return this.database.query.refreshTokens.findFirst({
			where: eq(refreshTokens.id, id),
		});
	}

	async deleteSession(id: string) {
		await this.database.delete(refreshTokens).where(eq(refreshTokens.id, id));
	}
}
