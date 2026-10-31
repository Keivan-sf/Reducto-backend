import { existsSync } from "node:fs";
import { Pool } from "pg";
import { initializeMessageEncryption } from "./message-encryption.js";

async function main() {
	if (existsSync(".env")) process.loadEnvFile(".env");
	if (process.env.MESSAGE_ENCRYPTION !== "true") {
		console.log(
			"Message encryption is disabled; set MESSAGE_ENCRYPTION=true to enable it.",
		);
		return;
	}
	if (!process.env.DATABASE_URL) throw new Error();
	// Read from stdin, never argv, an environment variable, or a temporary file.
	let masterKey = "";
	for await (const chunk of process.stdin) {
		masterKey += chunk.toString();
		if (masterKey.length > 4097) throw new Error();
	}
	masterKey = masterKey.replace(/\r?\n$/, "");
	const pool = new Pool({ connectionString: process.env.DATABASE_URL });
	try {
		const { updated } = await initializeMessageEncryption(
			pool,
			masterKey,
			true,
		);
		console.log(
			`Encrypted ${updated} message texts. Existing encrypted texts verified.`,
		);
	} finally {
		await pool.end();
	}
}

void main().catch(() => {
	console.error(
		"Encryption failed; transaction rolled back. Check the key, DATABASE_URL, and migrations.",
	);
	process.exitCode = 1;
});
