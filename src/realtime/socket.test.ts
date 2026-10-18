import { expect, test } from "@jest/globals";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { io as connect, type Socket } from "socket.io-client";
import { AuthService } from "../components/auth/auth.service.js";
import { InMemoryAuthRepository } from "../components/auth/auth.repository.js";
import { attachRealtime, SocketNotifications, userRoom } from "./socket.js";
import { createToken } from "../lib/jwt.js";

function onceEvent(socket: Socket, event: string): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error(`Timed out waiting for ${event}`)),
			3000,
		);
		socket.once(event, (value) => {
			clearTimeout(timer);
			resolve(value);
		});
	});
}

test("Socket.IO rejects invalid tokens and delivers notifications only to authenticated recipients", async () => {
	const auth = new AuthService(new InMemoryAuthRepository(), {
		accessTokenSecret: "test-access-secret-at-least-32-characters",
		refreshTokenSecret: "test-refresh-secret-at-least-32-characters",
		accessTokenLifetimeSeconds: 900,
		refreshTokenLifetimeSeconds: 3600,
	});
	const alice = await auth.signUp(
		"alice@example.com",
		"test-password",
		"Alice",
	);
	const bob = await auth.signUp("bob@example.com", "test-password", "Bob");
	const server = createServer();
	const io = attachRealtime(server, auth);
	const clients: Socket[] = [];
	try {
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});
		const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		for (const token of [
			"invalid-token",
			alice.tokens.accessToken,
			bob.tokens.accessToken,
			alice.tokens.refreshToken,
			createToken(
				{ sub: alice.user.id, type: "access" },
				"test-access-secret-at-least-32-characters",
				-1,
			),
		]) {
			const client = connect(url, {
				auth: { token },
				transports: ["websocket"],
				reconnection: false,
				autoConnect: false,
			});
			clients.push(client);
			const valid =
				token === alice.tokens.accessToken || token === bob.tokens.accessToken;
			const connected = onceEvent(client, valid ? "connect" : "connect_error");
			client.connect();
			const result = await connected;
			if (!valid) expect((result as Error).message).toBe("Unauthorized");
		}
		const aliceSocket = clients[1],
			bobSocket = clients[2];
		const leaked: unknown[] = [];
		bobSocket.on("message.created", (message) => leaked.push(message));
		bobSocket.emit("join", userRoom(alice.user.id));
		const received = onceEvent(aliceSocket, "message.created");
		const barrier = onceEvent(bobSocket, "test.barrier");
		new SocketNotifications(io).publish([alice.user.id], "message.created", {
			text: "Private",
		});
		io.emit("test.barrier");
		expect(await received).toEqual({ text: "Private" });
		await barrier;
		expect(leaked).toEqual([]);
	} finally {
		for (const client of clients) client.disconnect();
		await new Promise<void>((resolve) => io.close(() => resolve()));
	}
});
