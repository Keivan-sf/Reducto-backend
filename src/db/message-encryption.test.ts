import { expect, jest, test } from "@jest/globals";
import type { Pool } from "pg";
import {
	configureMessageEncryption,
	initializeMessageEncryption,
} from "./message-encryption.js";
import { ENCRYPTED_TEXT_PREFIX } from "../lib/message-encryption.js";

test.each([undefined, "false", "TRUE", "1", ""])(
	"encryption flag %s skips key retrieval and database initialization",
	async (flag) => {
		const request = jest.fn<typeof fetch>();
		const connect = jest.fn<Pool["connect"]>();
		const pool = { connect } as unknown as Pool;
		await expect(
			configureMessageEncryption(
				pool,
				{ MESSAGE_ENCRYPTION: flag, KEY_SERVER: "invalid url" },
				request,
			),
		).resolves.toBeUndefined();
		expect(request).not.toHaveBeenCalled();
		expect(connect).not.toHaveBeenCalled();
	},
);

test("true enables key retrieval and verifier initialization; missing key server fails", async () => {
	const db = fakeDatabase();
	const request = jest
		.fn<typeof fetch>()
		.mockResolvedValue(new Response(JSON.stringify({ master_key: "key" })));
	expect(
		await configureMessageEncryption(
			db.pool,
			{ MESSAGE_ENCRYPTION: "true", KEY_SERVER: "https://keys.example/key" },
			request,
		),
	).toBeDefined();
	expect(request).toHaveBeenCalledTimes(1);
	expect(db.state()).toBeDefined();
	await expect(
		configureMessageEncryption(
			db.pool,
			{ MESSAGE_ENCRYPTION: "true" },
			request,
		),
	).rejects.toThrow("Master key server unavailable");
});

function fakeDatabase(initial: { id: string; text: string | null }[] = []) {
	let state: { salt: string; verification: string } | undefined;
	let messages = structuredClone(initial);
	let snapshot: { state: typeof state; messages: typeof messages };
	const query = jest.fn(async (sql: string, values: unknown[] = []) => {
		if (sql === "BEGIN") snapshot = structuredClone({ state, messages });
		if (sql === "ROLLBACK") ({ state, messages } = snapshot);
		if (sql.startsWith("SELECT salt")) return { rows: state ? [state] : [] };
		if (sql.startsWith("INSERT INTO message_encryption"))
			state = { salt: values[0] as string, verification: values[1] as string };
		if (sql.startsWith("SELECT 1 FROM messages")) {
			const encrypted = !sql.includes("NOT LIKE");
			return {
				rowCount: messages.some(
					(m) =>
						m.text !== null &&
						m.text.startsWith(ENCRYPTED_TEXT_PREFIX) === encrypted,
				)
					? 1
					: 0,
				rows: [],
			};
		}
		if (sql.startsWith("SELECT id, text"))
			return {
				rows: messages
					.filter(
						(m) =>
							m.text !== null && (!values[0] || m.id > (values[0] as string)),
					)
					.sort((a, b) => a.id.localeCompare(b.id))
					.slice(0, 500),
			};
		if (sql.startsWith("UPDATE messages"))
			messages.find((m) => m.id === values[1])!.text = values[0] as string;
		return { rows: [] };
	});
	const release = jest.fn();
	const pool = { connect: async () => ({ query, release }) } as unknown as Pool;
	return { pool, query, release, state: () => state, messages: () => messages };
}

test("first startup stores only encrypted verification; later startup verifies and rejects wrong keys", async () => {
	const db = fakeDatabase();
	await initializeMessageEncryption(db.pool, "correct master key");
	expect(db.state()?.verification).toMatch(/^reducto:v1:/);
	expect(JSON.stringify(db.state())).not.toContain("correct master key");
	await initializeMessageEncryption(db.pool, "correct master key");
	await expect(
		initializeMessageEncryption(db.pool, "wrong master key"),
	).rejects.toThrow("Master key verification failed");
	expect(db.query).toHaveBeenLastCalledWith("ROLLBACK");
	expect(db.release).toHaveBeenCalledTimes(3);
});

test("startup refuses legacy plaintext, and backfill is atomic, skips nulls, and is repeatable", async () => {
	const db = fakeDatabase([
		{ id: "1", text: "hello" },
		{ id: "2", text: null },
		{ id: "3", text: "" },
	]);
	await expect(initializeMessageEncryption(db.pool, "key")).rejects.toThrow(
		"Unencrypted messages exist",
	);
	expect(db.state()).toBeUndefined();
	const result = await initializeMessageEncryption(db.pool, "key", true);
	expect(result.updated).toBe(2);
	expect(result.encryption.decrypt(db.messages()[0]!.text!, "1")).toBe("hello");
	expect(db.messages()[1]!.text).toBeNull();
	expect(result.encryption.decrypt(db.messages()[2]!.text!, "3")).toBe("");
	expect(
		(await initializeMessageEncryption(db.pool, "key", true)).updated,
	).toBe(0);
	await initializeMessageEncryption(db.pool, "key");
	const previous = structuredClone(db.messages());
	await expect(
		initializeMessageEncryption(db.pool, "wrong", true),
	).rejects.toThrow();
	expect(db.messages()).toEqual(previous);
});

test("backfill failure rolls back both messages and the verifier; missing verifier fails closed", async () => {
	const db = fakeDatabase([
		{ id: "1", text: "hello" },
		{ id: "2", text: "world" },
	]);
	const original = db.query.getMockImplementation()!;
	db.query.mockImplementation(async (sql, values) => {
		if (sql.startsWith("UPDATE messages") && values?.[1] === "2")
			throw new Error("write failed");
		return original(sql, values);
	});
	await expect(
		initializeMessageEncryption(db.pool, "key", true),
	).rejects.toThrow("write failed");
	expect(db.state()).toBeUndefined();
	expect(db.messages().map((m) => m.text)).toEqual(["hello", "world"]);
	const missing = fakeDatabase([{ id: "1", text: "reducto:v1:encrypted" }]);
	await expect(
		initializeMessageEncryption(missing.pool, "key"),
	).rejects.toThrow("verification record missing");
});
