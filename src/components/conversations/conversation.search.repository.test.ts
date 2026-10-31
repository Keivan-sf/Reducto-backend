import { MessageEncryption } from "../../lib/message-encryption.js";
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
	const repository = new DrizzleConversationRepository(
		database,
		await MessageEncryption.derive("test key", Buffer.alloc(16)),
	);
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
		expect(text).not.toContain(" ilike ");
		expect(text).toContain("(select created_at, id from messages where id =");
		expect(text).toContain(
			'order by "messages"."created_at" desc, "messages"."id" desc',
		);
		expect(text).not.toContain("100%");
		expect(params).toEqual([userId, conversationId, before.id, 500]);
		query.mockClear();
		await repository.searchMessages(userId, "text", 51);
		const unscoped = query.mock.calls[0]!;
		expect(unscoped[1]).toEqual([userId, 500]);
	} finally {
		query.mockRestore();
		await database.$client.end();
	}
});
