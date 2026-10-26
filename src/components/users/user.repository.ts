import { eq } from "drizzle-orm";
import type { createDatabase } from "../../db/client.js";
import { users } from "../../db/schema.js";

export type UserProfileRecord = {
	id: string;
	name: string;
	username: string | null;
	avatarKey: string | null;
	lastSeen?: Date | null;
};

export interface UserRepository {
	findById(id: string): Promise<UserProfileRecord | undefined>;
	findByUsername(username: string): Promise<UserProfileRecord | undefined>;
}

const profileColumns = {
	id: users.id,
	name: users.name,
	username: users.username,
	avatarKey: users.avatarKey,
	lastSeen: users.lastSeen,
};

export class DrizzleUserRepository implements UserRepository {
	constructor(private readonly database: ReturnType<typeof createDatabase>) {}

	async findById(id: string) {
		const [user] = await this.database
			.select(profileColumns)
			.from(users)
			.where(eq(users.id, id))
			.limit(1);
		return user;
	}

	async findByUsername(username: string) {
		const [user] = await this.database
			.select(profileColumns)
			.from(users)
			.where(eq(users.username, username.toLowerCase()))
			.limit(1);
		return user;
	}
}
