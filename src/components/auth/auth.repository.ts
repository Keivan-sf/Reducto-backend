import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { createDatabase } from "../../db/client.js";
import { refreshTokens, users } from "../../db/schema.js";

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
		const [createdUser] = await this.database
			.insert(users)
			.values(user)
			.returning();
		return createdUser;
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
