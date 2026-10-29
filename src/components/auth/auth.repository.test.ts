import { expect, jest, test } from "@jest/globals";
import { randomUUID } from "node:crypto";
import { createDatabase } from "../../db/client.js";
import { DrizzleAuthRepository } from "./auth.repository.js";

test.each([false, true])(
	"account and Saved Messages creation are atomic (membership failure: %s)",
	async (failMembership) => {
		const database = createDatabase(
			"postgres://unused:unused@localhost/unused",
		);
		const userId = randomUUID();
		const conversationId = randomUUID();
		const failure = new Error("Membership insert failed");
		const queries: { text: string; values: unknown[] }[] = [];
		const query = jest.fn(
			async (config: string | { text: string }, values: unknown[] = []) => {
				const text = typeof config === "string" ? config : config.text;
				queries.push({ text, values });
				if (text.startsWith('insert into "users"'))
					return {
						rows: [
							[
								userId,
								"alice@example.com",
								"Alice",
								null,
								null,
								"hash",
								null,
								new Date(),
							],
						],
					};
				if (text.startsWith('insert into "conversations"'))
					return {
						rows: [
							[
								conversationId,
								"saved",
								"Saved Messages",
								null,
								null,
								userId,
								new Date(),
							],
						],
					};
				if (
					text.startsWith('insert into "conversation_members"') &&
					failMembership
				)
					throw failure;
				return { rows: [] };
			},
		);
		const release = jest.fn();
		const connect = jest
			.spyOn(database.$client, "connect")
			.mockResolvedValue({ query, release } as never);
		try {
			const operation = new DrizzleAuthRepository(database).createUser({
				email: "alice@example.com",
				name: "Alice",
				passwordHash: "hash",
			});
			if (failMembership)
				await expect(operation).rejects.toMatchObject({ cause: failure });
			else await expect(operation).resolves.toMatchObject({ id: userId });
			expect(queries[0]?.text).toBe("begin");
			expect(queries).toHaveLength(5);
			expect(queries[2]?.values).toEqual(["saved", "Saved Messages", userId]);
			expect(queries[3]?.values).toEqual([conversationId, userId, "owner"]);
			expect(queries[4]?.text).toBe(failMembership ? "rollback" : "commit");
			expect(release).toHaveBeenCalledTimes(1);
		} finally {
			connect.mockRestore();
			await database.$client.end();
		}
	},
);
