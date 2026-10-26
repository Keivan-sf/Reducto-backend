import { and, eq, ne } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { createDatabase } from "../../db/client.js";
import { conversationMembers, users } from "../../db/schema.js";

export type SettingsUser = {
	id: string;
	name: string;
	username: string | null;
	avatarKey: string | null;
	lastSeen?: Date | null;
};

export interface SettingsRepository {
	findConversationPeerIds(userId: string): Promise<string[]>;
	findUserById(id: string): Promise<SettingsUser | undefined>;
	findUserByUsername(username: string): Promise<SettingsUser | undefined>;
	updateUser(
		id: string,
		changes: Partial<Pick<SettingsUser, "name" | "username" | "avatarKey">>,
	): Promise<SettingsUser>;
}

export class InMemorySettingsRepository implements SettingsRepository {
	constructor(
		private readonly userRecords = new Map<string, SettingsUser>(),
		private readonly memberships = new Map<string, Set<string>>(),
	) {}

	async findConversationPeerIds(userId: string) {
		const peers = new Set<string>();
		for (const members of this.memberships.values()) {
			if (members.has(userId)) {
				for (const memberId of members)
					if (memberId !== userId) peers.add(memberId);
			}
		}
		return [...peers];
	}

	async findUserById(id: string) {
		return this.userRecords.get(id);
	}

	async findUserByUsername(username: string) {
		return [...this.userRecords.values()].find(
			(user) => user.username === username,
		);
	}

	async updateUser(
		id: string,
		changes: Partial<Pick<SettingsUser, "name" | "username" | "avatarKey">>,
	) {
		const user = this.userRecords.get(id);
		if (!user) throw new Error("User not found");
		const updatedUser = { ...user, ...changes };
		this.userRecords.set(id, updatedUser);
		return updatedUser;
	}
}

type Database = ReturnType<typeof createDatabase>;

export class DrizzleSettingsRepository implements SettingsRepository {
	constructor(private readonly database: Database) {}

	async findConversationPeerIds(userId: string) {
		const ownMembership = alias(
			conversationMembers,
			"profile_owner_membership",
		);
		const peers = await this.database
			.selectDistinct({ userId: conversationMembers.userId })
			.from(ownMembership)
			.innerJoin(
				conversationMembers,
				and(
					eq(ownMembership.conversationId, conversationMembers.conversationId),
					ne(conversationMembers.userId, userId),
				),
			)
			.where(eq(ownMembership.userId, userId));
		return peers.map((peer) => peer.userId);
	}

	async findUserById(id: string) {
		return this.database.query.users.findFirst({ where: eq(users.id, id) });
	}

	async findUserByUsername(username: string) {
		return this.database.query.users.findFirst({
			where: eq(users.username, username),
		});
	}

	async updateUser(
		id: string,
		changes: Partial<Pick<SettingsUser, "name" | "username" | "avatarKey">>,
	) {
		const [user] = await this.database
			.update(users)
			.set(changes)
			.where(eq(users.id, id))
			.returning();
		return user;
	}
}
