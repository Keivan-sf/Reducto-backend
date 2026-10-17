import { eq } from "drizzle-orm";
import type { createDatabase } from "../../db/client.js";
import { users } from "../../db/schema.js";

export type SettingsUser = {
	id: string;
	name: string;
	username: string | null;
	avatarKey: string | null;
};

export interface SettingsRepository {
	findUserById(id: string): Promise<SettingsUser | undefined>;
	findUserByUsername(username: string): Promise<SettingsUser | undefined>;
	updateUser(
		id: string,
		changes: Partial<Pick<SettingsUser, "name" | "username" | "avatarKey">>,
	): Promise<SettingsUser>;
}

export class InMemorySettingsRepository implements SettingsRepository {
	constructor(private readonly userRecords = new Map<string, SettingsUser>()) {}

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
