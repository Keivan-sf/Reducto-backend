import { expect, jest, test } from "@jest/globals";
import { MessageEncryption, fetchMasterKey } from "./message-encryption.js";

test("authenticated encryption round trips Unicode and empty text with unique nonces", async () => {
	const cipher = await MessageEncryption.derive(
		"a strong test master key",
		Buffer.alloc(16, 1),
	);
	for (const text of ["", "hello 👋 سلام", "a".repeat(10000)]) {
		const first = cipher.encrypt(text, "message-id");
		expect(first).not.toEqual(cipher.encrypt(text, "message-id"));
		expect(cipher.decrypt(first, "message-id")).toBe(text);
	}
	const encrypted = cipher.encrypt("secret", "message-id");
	expect(encrypted).not.toContain("secret");
	expect(() => cipher.decrypt(encrypted, "other-message")).toThrow();
	const other = await MessageEncryption.derive(
		"wrong key",
		Buffer.alloc(16, 1),
	);
	expect(() => other.decrypt(encrypted, "message-id")).toThrow();
	const payload = Buffer.from(encrypted.split(":")[2]!, "base64");
	payload[payload.length - 1]! ^= 1;
	expect(() =>
		cipher.decrypt("reducto:v1:" + payload.toString("base64"), "message-id"),
	).toThrow();
	for (const invalid of ["plaintext", "reducto:v1:abc", "reducto:v1:!!!!"]) {
		expect(() => cipher.decrypt(invalid, "message-id")).toThrow();
	}
});

test("fetches the key with GET, a timeout, and no redirects", async () => {
	const request = jest
		.fn<typeof fetch>()
		.mockResolvedValue(
			new Response(JSON.stringify({ master_key: "my secret" })),
		);
	await expect(
		fetchMasterKey("https://keys.example/key", request),
	).resolves.toBe("my secret");
	expect(request).toHaveBeenCalledWith(
		"https://keys.example/key",
		expect.objectContaining({
			method: "GET",
			redirect: "error",
			signal: expect.any(AbortSignal),
		}),
	);
});

test("key server errors and invalid responses fail without exposing secrets", async () => {
	for (const response of [
		new Response("private error", { status: 500 }),
		new Response("not json"),
		new Response("null"),
		new Response("{}"),
		new Response('{"master_key":""}'),
		new Response('{"master_key":1}'),
		new Response("x".repeat(32769)),
	]) {
		const request = jest.fn<typeof fetch>().mockResolvedValue(response);
		await expect(
			fetchMasterKey("https://keys.example/key", request),
		).rejects.toThrow(
			"Master key server unavailable or returned an invalid response",
		);
	}
	const request = jest
		.fn<typeof fetch>()
		.mockRejectedValue(new Error("secret URL and response"));
	await expect(
		fetchMasterKey("https://keys.example/key", request),
	).rejects.toThrow(
		"Master key server unavailable or returned an invalid response",
	);
	await expect(fetchMasterKey("file:///secret", request)).rejects.toThrow();
});
