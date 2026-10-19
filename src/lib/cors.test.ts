import { expect, test } from "@jest/globals";
import { createServer } from "node:http";
import request from "supertest";
import { createApp } from "../app.js";
import { AuthService } from "../components/auth/auth.service.js";
import { InMemoryAuthRepository } from "../components/auth/auth.repository.js";
import type { SettingsService } from "../components/settings/settings.service.js";
import type { GifService } from "../components/gifs/gif.service.js";
import type { ConversationService } from "../components/conversations/conversation.service.js";
import type { UserService } from "../components/users/user.service.js";
import { attachRealtime } from "../realtime/socket.js";

function fixture() {
	const auth = new AuthService(new InMemoryAuthRepository(), {
		accessTokenSecret: "test-access-secret-at-least-32-characters",
		refreshTokenSecret: "test-refresh-secret-at-least-32-characters",
		accessTokenLifetimeSeconds: 900,
		refreshTokenLifetimeSeconds: 3600,
	});
	const app = createApp(
		auth,
		{} as SettingsService,
		{} as GifService,
		{} as ConversationService,
		{} as UserService,
	);
	return { app, auth };
}

test("HTTP accepts arbitrary origins and credentialed preflights with requested headers", async () => {
	const { app } = fixture();
	for (const origin of [
		"http://localhost:8081",
		"https://any-client.example",
		"null",
	]) {
		const health = await request(app)
			.get("/health")
			.set("Origin", origin)
			.expect(200);
		expect(health.headers["access-control-allow-origin"]).toBe(origin);
		expect(health.headers["access-control-allow-credentials"]).toBe("true");
		expect(health.headers.vary).toContain("Origin");
		const preflight = await request(app)
			.options("/api/settings/profile")
			.set("Origin", origin)
			.set("Access-Control-Request-Method", "PATCH")
			.set(
				"Access-Control-Request-Headers",
				"authorization,content-type,x-client-header",
			)
			.expect(204);
		expect(preflight.headers["access-control-allow-origin"]).toBe(origin);
		expect(preflight.headers["access-control-allow-methods"]).toContain(
			"PATCH",
		);
		expect(preflight.headers["access-control-allow-headers"]).toBe(
			"authorization,content-type,x-client-header",
		);
	}
	await request(app).get("/health").expect(200);
});

test("cross-origin protected requests still require authentication and expose CORS headers on errors", async () => {
	const { app } = fixture();
	const result = await request(app)
		.get("/api/auth/me")
		.set("Origin", "https://any-client.example")
		.expect(401);
	expect(result.headers["access-control-allow-origin"]).toBe(
		"https://any-client.example",
	);
	expect(result.headers["access-control-expose-headers"]).toContain(
		"Content-Disposition",
	);
});

test("Socket.IO polling and preflights accept arbitrary origins with credentials", async () => {
	const { app, auth } = fixture();
	const server = createServer(app);
	const io = attachRealtime(server, auth);
	try {
		const origin = "https://socket-client.example";
		const preflight = await request(server)
			.options("/socket.io/?EIO=4&transport=polling")
			.set("Origin", origin)
			.set("Access-Control-Request-Method", "POST")
			.set("Access-Control-Request-Headers", "authorization,content-type")
			.expect(204);
		expect(preflight.headers["access-control-allow-origin"]).toBe(origin);
		expect(preflight.headers["access-control-allow-credentials"]).toBe("true");
		expect(preflight.headers["access-control-allow-headers"]).toBe(
			"authorization,content-type",
		);
		const handshake = await request(server)
			.get("/socket.io/?EIO=4&transport=polling")
			.set("Origin", origin)
			.expect(200);
		expect(handshake.headers["access-control-allow-origin"]).toBe(origin);
		expect(handshake.text).toContain('"sid"');
	} finally {
		await new Promise<void>((resolve) => io.close(() => resolve()));
	}
});
