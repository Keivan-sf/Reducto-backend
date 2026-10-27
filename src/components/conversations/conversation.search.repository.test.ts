import { expect, jest, test } from "@jest/globals";
import { randomUUID } from "node:crypto";
import { createDatabase } from "../../db/client.js";
import { DrizzleConversationRepository } from "./conversation.repository.js";
import type { Message } from "./conversation.types.js";

test("database search joins membership and attachment metadata, binds literal text and preserves timestamp precision", async () => {
	const database = createDatabase("postgres://unused:unused@localhost/unused");
	const query = jest
		.spyOn(database.$client, "query")
		.mockResolvedValue({ rows: [] } as never);
	const repository = new DrizzleConversationRepository(database);
	const userId = randomUUID();
	const conversationId = randomUUID();
	const before = { id: randomUUID() } as Message;
	try {
		expect(
			await repository.searchMessages(
				userId,
				"100%_\\'",
				11,
				before,
				conversationId,
			),
		).toEqual([]);
		const [config, params] = query.mock.calls[0]!;
		const text =
			typeof config === "string" ? config : (config as { text: string }).text;
		expect(text).toContain('inner join "conversation_members"');
		expect(text).toContain('"conversation_members"."user_id" = $1');
		expect(text).toContain('left join "conversation_media"');
		expect(text).toContain("->>'mediaId'");
		for (const column of [
			'"messages"."text"',
			'"conversation_media"."file_name"',
			'"conversation_media"."title"',
			'"conversation_media"."artist"',
		]) {
			expect(text).toContain(`${column} ilike`);
		}
		expect(text).toContain("(select created_at, id from messages where id =");
		expect(text).toContain(
			'order by "messages"."created_at" desc, "messages"."id" desc',
		);
		expect(text).not.toContain("100%");
		expect(params).toEqual([
			userId,
			conversationId,
			"%100\\%\\_\\\\'%",
			"%100\\%\\_\\\\'%",
			"music",
			"%100\\%\\_\\\\'%",
			"%100\\%\\_\\\\'%",
			before.id,
			11,
		]);
		query.mockClear();
		await repository.searchMessages(userId, "text", 51);
		const unscoped = query.mock.calls[0]!;
		expect(unscoped[1]).toEqual([
			userId,
			"%text%",
			"%text%",
			"music",
			"%text%",
			"%text%",
			51,
		]);
	} finally {
		query.mockRestore();
		await database.$client.end();
	}
});
