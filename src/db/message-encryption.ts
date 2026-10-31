import { randomBytes } from "node:crypto";
import type { Pool, QueryResult } from "pg";
import {
	ENCRYPTED_TEXT_PREFIX,
	KEY_VERIFICATION_TEXT,
	MessageEncryption,
	fetchMasterKey,
} from "../lib/message-encryption.js";

export async function configureMessageEncryption(
	pool: Pool,
	environment: { MESSAGE_ENCRYPTION?: string; KEY_SERVER?: string },
	request: typeof fetch = fetch,
) {
	if (environment.MESSAGE_ENCRYPTION !== "true") return undefined;
	const masterKey = await fetchMasterKey(environment.KEY_SERVER ?? "", request);
	return (await initializeMessageEncryption(pool, masterKey)).encryption;
}

// The sentinel, salt and message updates share a transaction. The lock also
// serializes first startup across instances and excludes concurrent message writes.
export async function initializeMessageEncryption(
	pool: Pool,
	masterKey: string,
	backfill = false,
) {
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		await client.query("SET LOCAL statement_timeout = '30s'");
		await client.query("SELECT pg_advisory_xact_lock(726334801)");
		await client.query(
			"LOCK TABLE message_encryption, messages IN SHARE ROW EXCLUSIVE MODE",
		);
		const state = await client.query<{ salt: string; verification: string }>(
			"SELECT salt, verification FROM message_encryption WHERE id = 1",
		);
		const existing = state.rows[0];
		if (!existing) {
			const encrypted = await client.query(
				"SELECT 1 FROM messages WHERE text LIKE $1 LIMIT 1",
				[ENCRYPTED_TEXT_PREFIX + "%"],
			);
			if (encrypted.rowCount)
				throw new Error(
					"Encryption verification record missing for encrypted messages",
				);
		}
		const salt = existing
			? Buffer.from(existing.salt, "base64")
			: randomBytes(16);
		const encryption = await MessageEncryption.derive(masterKey, salt);
		if (existing) {
			try {
				if (
					encryption.decrypt(existing.verification, "key-verification") !==
					KEY_VERIFICATION_TEXT
				)
					throw new Error();
			} catch {
				throw new Error("Master key verification failed");
			}
		} else {
			await client.query(
				"INSERT INTO message_encryption (id, salt, verification) VALUES (1, $1, $2)",
				[
					salt.toString("base64"),
					encryption.encrypt(KEY_VERIFICATION_TEXT, "key-verification"),
				],
			);
		}
		let updated = 0;
		if (backfill) {
			let after: string | null = null;
			for (;;) {
				const batch: QueryResult<{ id: string; text: string }> =
					await client.query(
						"SELECT id, text FROM messages WHERE text IS NOT NULL AND ($1::uuid IS NULL OR id > $1::uuid) ORDER BY id LIMIT 500",
						[after],
					);
				if (!batch.rows.length) break;
				for (const row of batch.rows) {
					if (row.text.startsWith(ENCRYPTED_TEXT_PREFIX))
						encryption.decrypt(row.text, row.id);
					else {
						await client.query("UPDATE messages SET text = $1 WHERE id = $2", [
							encryption.encrypt(row.text, row.id),
							row.id,
						]);
						updated++;
					}
				}
				after = batch.rows[batch.rows.length - 1]!.id;
			}
		} else {
			const plaintext = await client.query(
				"SELECT 1 FROM messages WHERE text IS NOT NULL AND text NOT LIKE $1 LIMIT 1",
				[ENCRYPTED_TEXT_PREFIX + "%"],
			);
			if (plaintext.rowCount)
				throw new Error(
					"Unencrypted messages exist; stop the API and run scripts/encrypt-messages.sh first",
				);
		}
		await client.query("COMMIT");
		return { encryption, updated };
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
	}
}
