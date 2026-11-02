import { expect, jest, test } from "@jest/globals";
import { createDatabase } from "../../db/client.js";
import { DrizzleAdminRepository } from "./admin.repository.js";

test.each([false, true])(
	"cleanup uses bounded media batches and safe deletion order (S3 failure=%s)",
	async (fail) => {
		const db = createDatabase("postgres://unused:unused@localhost/unused");
		const statements: string[] = [];
		let page = 0;
		const query = jest.spyOn(db.$client, "query").mockImplementation((async (
			config: { text: string },
			params: unknown[],
		) => {
			const text = config.text;
			statements.push(text);
			if (
				text.startsWith("select") &&
				text.includes('from "conversation_media"')
			) {
				expect(text).toContain("limit");
				if (page++ === 0)
					return {
						rows: [
							[
								"00000000-0000-0000-0000-000000000001",
								"attachments/a",
								"thumbnails/attachments/a",
								null,
							],
						],
					};
				if (page === 2) {
					expect(text).toContain('"conversation_media"."id" >');
					expect(params).toContain("00000000-0000-0000-0000-000000000001");
					return {
						rows: [
							[
								"00000000-0000-0000-0000-000000000002",
								"attachments/b",
								null,
								"covers/attachments/b",
							],
						],
					};
				}
				return { rows: [] };
			}
			if (text.includes("count(*)")) return { rows: [[7]] };
			return { rows: [] };
		}) as never);
		const transaction = jest
			.spyOn(db, "transaction")
			.mockImplementation(async (callback) => callback(db as never));
		const deleteFiles = jest.fn(async (_keys: string[]) => {
			expect(
				statements.some((statement) => statement.startsWith("delete")),
			).toBe(false);
			if (fail) throw new Error("S3 failed");
		});
		try {
			const cleanup = new DrizzleAdminRepository(db).cleanup(deleteFiles);
			if (fail) {
				await expect(cleanup).rejects.toThrow("S3 failed");
				expect(
					statements.some((statement) => /^(delete|update)/.test(statement)),
				).toBe(false);
			} else {
				await expect(cleanup).resolves.toEqual({
					deletedMessages: 7,
					deletedAttachments: 2,
				});
				expect(deleteFiles.mock.calls).toEqual([
					[["attachments/a", "thumbnails/attachments/a"]],
					[["attachments/b", "covers/attachments/b"]],
				]);
				const mutations = statements.filter((statement) =>
					/^(delete|update)/.test(statement),
				);
				expect(mutations).toEqual([
					'update "conversation_members" set "last_seen_message_id" = $1',
					'delete from "messages"',
					'delete from "conversation_media"',
				]);
			}
			expect(statements[0]).toContain("SHARE ROW EXCLUSIVE MODE");
			expect(statements.join(" ")).not.toMatch(
				/\b(gifs|user_gifs|users|conversations|refresh_tokens)\b/,
			);
		} finally {
			transaction.mockRestore();
			query.mockRestore();
			await db.$client.end();
		}
	},
);
