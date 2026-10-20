import { and, desc, eq } from "drizzle-orm";
import type { createDatabase } from "../../db/client.js";
import { gifs, userGifs, users } from "../../db/schema.js";

export type UserGif = {
	id: string;
	userId: string;
	objectKey: string;
	fileSize: number;
	width: number | null;
	height: number | null;
	createdAt: Date;
};

export interface GifRepository {
	userExists(userId: string): Promise<boolean>;
	createGif(gif: Omit<UserGif, "id" | "createdAt">): Promise<UserGif>;
	listGifs(userId: string): Promise<UserGif[]>;
	findGif(gifId: string): Promise<UserGif | undefined>;
	addToLibrary(userId: string, gifId: string): Promise<void>;
	deleteGif(userId: string, gifId: string): Promise<void>;
}

export class InMemoryGifRepository implements GifRepository {
	private readonly gifRecords = new Map<string, UserGif>();
	private readonly libraries = new Map<string, Set<string>>();

	constructor(private readonly userIds = new Set<string>()) {}

	async userExists(userId: string) {
		return this.userIds.has(userId);
	}

	async createGif(gif: Omit<UserGif, "id" | "createdAt">) {
		const createdGif: UserGif = {
			...gif,
			id: crypto.randomUUID(),
			createdAt: new Date(),
		};
		this.gifRecords.set(createdGif.id, createdGif);
		await this.addToLibrary(gif.userId, createdGif.id);
		return createdGif;
	}

	async listGifs(userId: string) {
		return [...this.gifRecords.values()].filter((gif) =>
			this.libraries.get(userId)?.has(gif.id),
		);
	}

	async findGif(gifId: string) {
		return this.gifRecords.get(gifId);
	}

	async addToLibrary(userId: string, gifId: string) {
		const library = this.libraries.get(userId) ?? new Set<string>();
		library.add(gifId);
		this.libraries.set(userId, library);
	}

	async deleteGif(userId: string, gifId: string) {
		this.libraries.get(userId)?.delete(gifId);
	}
}

type Database = ReturnType<typeof createDatabase>;

export class DrizzleGifRepository implements GifRepository {
	constructor(private readonly database: Database) {}

	async userExists(userId: string) {
		return Boolean(
			await this.database.query.users.findFirst({
				where: eq(users.id, userId),
			}),
		);
	}

	async createGif(gif: Omit<UserGif, "id" | "createdAt">) {
		return this.database.transaction(async (transaction) => {
			const [createdGif] = await transaction
				.insert(gifs)
				.values(gif)
				.returning();
			await transaction
				.insert(userGifs)
				.values({ userId: gif.userId, gifId: createdGif.id });
			return createdGif;
		});
	}

	async listGifs(userId: string) {
		const records = await this.database
			.select({ gif: gifs })
			.from(userGifs)
			.innerJoin(gifs, eq(userGifs.gifId, gifs.id))
			.where(eq(userGifs.userId, userId))
			.orderBy(desc(userGifs.createdAt));
		return records.map((record) => record.gif);
	}

	async findGif(gifId: string) {
		return this.database.query.gifs.findFirst({
			where: eq(gifs.id, gifId),
		});
	}

	async addToLibrary(userId: string, gifId: string) {
		await this.database
			.insert(userGifs)
			.values({ userId, gifId })
			.onConflictDoNothing();
	}

	async deleteGif(userId: string, gifId: string) {
		await this.database
			.delete(userGifs)
			.where(and(eq(userGifs.gifId, gifId), eq(userGifs.userId, userId)));
	}
}
