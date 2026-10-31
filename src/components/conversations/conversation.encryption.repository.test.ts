import { expect, jest, test } from "@jest/globals";
import { createDatabase } from "../../db/client.js";
import { MessageEncryption } from "../../lib/message-encryption.js";
import { DrizzleConversationRepository } from "./conversation.repository.js";

test.each([true, false])(
	"repository uses encryption=%s for inserts and edits while reads return plaintext",
	async (enabled) => {
		const db = createDatabase("postgres://unused:unused@localhost/unused");
		const encryption = enabled
			? await MessageEncryption.derive("test key", Buffer.alloc(16))
			: undefined;
		const repository = new DrizzleConversationRepository(db, encryption);
		let stored: unknown[];
		const query = jest.spyOn(db.$client, "query").mockImplementation((async (
			_config: unknown,
			params: unknown[],
		) => {
			const sql = (_config as { text: string }).text;
			if (sql.startsWith("insert")) {
				stored = [
					params[0],
					params[1],
					params[2],
					params[3],
					false,
					null,
					null,
					null,
					"2026-01-01T00:00:00Z",
				];
			} else if (sql.startsWith("update")) {
				stored[3] = params[0];
				stored[4] = true;
			}
			return { rows: [stored!] };
		}) as never);
		// Keep transaction tests offline; statements still use real Drizzle mappings.
		const transaction = jest
			.spyOn(db, "transaction")
			.mockImplementation(async (callback) => callback(db as never));
		try {
			const { message } = await repository.createMessage({
				conversationId: "chat",
				senderId: "sender",
				text: "hello",
				attachment: null,
				forwardedFrom: null,
				replyToMessageId: null,
			});
			expect(message.text).toBe("hello");
			if (encryption) {
				expect(stored![3]).not.toBe("hello");
				expect(encryption.decrypt(stored![3] as string, message.id)).toBe(
					"hello",
				);
			} else expect(stored![3]).toBe("hello");
			const edited = await repository.updateMessageText(
				"chat",
				message.id,
				"sender",
				"edited",
			);
			expect(edited?.text).toBe("edited");
			if (encryption)
				expect(encryption.decrypt(stored![3] as string, message.id)).toBe(
					"edited",
				);
			else expect(stored![3]).toBe("edited");
			expect((await repository.getMessage(message.id))?.text).toBe("edited");
			expect((await repository.getFirstMessage("chat"))?.text).toBe("edited");
			expect((await repository.listMessages("chat", 10))[0]?.text).toBe(
				"edited",
			);
			expect(
				(await repository.listMessagesAfter("chat", 10, message))[0]?.text,
			).toBe("edited");
		} finally {
			transaction.mockRestore();
			query.mockRestore();
			await db.$client.end();
		}
	},
);

test("search decrypts authorized rows across batches and matches text and metadata literally", async () => {
	const db = createDatabase("postgres://unused:unused@localhost/unused");
	const encryption = await MessageEncryption.derive(
		"test key",
		Buffer.alloc(16),
	);
	const repository = new DrizzleConversationRepository(db, encryption);
	const row = (
		id: string,
		text: string | null,
		fileName: string | null = null,
	) => [
		id,
		"chat",
		"sender",
		text === null ? null : encryption.encrypt(text, id),
		false,
		null,
		null,
		null,
		"2026-01-01T00:00:00Z",
		fileName,
		"document",
		null,
		null,
	];
	const query = jest
		.spyOn(db.$client, "query")
		.mockResolvedValueOnce({
			rows: Array.from({ length: 500 }, (_, i) => row(String(i), "unrelated")),
		} as never)
		.mockResolvedValueOnce({
			rows: [
				row("match", "HELLO 100%_\\"),
				row("file", null, "100%_\\.txt"),
				row("ignored", "100000"),
			],
		} as never);
	try {
		const results = await repository.searchMessages("user", "100%_\\", 3);
		expect(results.map((m) => m.id)).toEqual(["match", "file"]);
		expect(results[0]?.text).toBe("HELLO 100%_\\");
		expect(query.mock.calls[1]?.[1]).toEqual(["user", "499", 500]);
	} finally {
		query.mockRestore();
		await db.$client.end();
	}
});
