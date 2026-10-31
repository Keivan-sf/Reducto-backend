import {
	createCipheriv,
	createDecipheriv,
	randomBytes,
	scrypt,
} from "node:crypto";

export const ENCRYPTED_TEXT_PREFIX = "reducto:v1:";
export const KEY_VERIFICATION_TEXT =
	"Reducto message encryption key verification v1";

export class MessageEncryption {
	private constructor(private readonly key: Buffer) {}

	static async derive(
		masterKey: string,
		salt: Buffer,
	): Promise<MessageEncryption> {
		if (!masterKey.length || masterKey.length > 4096 || salt.length !== 16)
			throw new Error("Invalid encryption key or salt");
		const key = await new Promise<Buffer>((resolve, reject) => {
			scrypt(
				masterKey,
				salt,
				32,
				{ N: 32768, maxmem: 64 * 1024 * 1024 },
				(error, key) => {
					if (error) reject(error);
					else resolve(key);
				},
			);
		});
		return new MessageEncryption(key);
	}

	encrypt(text: string, context: string): string {
		const nonce = randomBytes(12);
		const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
		cipher.setAAD(Buffer.from(context));
		const ciphertext = Buffer.concat([
			cipher.update(text, "utf8"),
			cipher.final(),
		]);
		return (
			ENCRYPTED_TEXT_PREFIX +
			Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString("base64")
		);
	}

	decrypt(value: string, context: string): string {
		if (!value.startsWith(ENCRYPTED_TEXT_PREFIX))
			throw new Error("Unencrypted message text; run the encryption script");
		const encoded = value.slice(ENCRYPTED_TEXT_PREFIX.length);
		const payload = Buffer.from(encoded, "base64");
		if (payload.length < 28 || payload.toString("base64") !== encoded)
			throw new Error("Invalid encrypted text");
		const decipher = createDecipheriv(
			"aes-256-gcm",
			this.key,
			payload.subarray(0, 12),
			{ authTagLength: 16 },
		);
		decipher.setAAD(Buffer.from(context));
		decipher.setAuthTag(payload.subarray(12, 28));
		return Buffer.concat([
			decipher.update(payload.subarray(28)),
			decipher.final(),
		]).toString("utf8");
	}
}

export async function fetchMasterKey(
	url: string,
	request: typeof fetch = fetch,
): Promise<string> {
	try {
		const parsed = new URL(url);
		if (!["http:", "https:"].includes(parsed.protocol)) throw new Error();
		const response = await request(url, {
			method: "GET",
			redirect: "error",
			signal: AbortSignal.timeout(5000),
			headers: { Accept: "application/json" },
		});
		if (!response.ok || !response.body) throw new Error();
		const reader = response.body.getReader();
		const chunks: Uint8Array[] = [];
		let size = 0;
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				size += value.length;
				if (size > 32768) throw new Error();
				chunks.push(value);
			}
		} finally {
			await reader.cancel();
		}
		const data = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
			master_key?: unknown;
		};
		if (
			typeof data?.master_key !== "string" ||
			!data.master_key.length ||
			data.master_key.length > 4096
		)
			throw new Error();
		return data.master_key;
	} catch {
		// Never include response bodies, URLs, or underlying exceptions containing secrets.
		throw new Error(
			"Master key server unavailable or returned an invalid response",
		);
	}
}
