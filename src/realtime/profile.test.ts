import { expect, test } from "@jest/globals";
import express from "express";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { io as connect, type Socket } from "socket.io-client";
import request from "supertest";
import sharp from "sharp";
import { InMemoryAuthRepository } from "../components/auth/auth.repository.js";
import { AuthService } from "../components/auth/auth.service.js";
import { MemoryChatStorage } from "../components/conversations/conversation.test-support.js";
import { InMemorySettingsRepository } from "../components/settings/settings.repository.js";
import { createSettingsRouter } from "../components/settings/settings.router.js";
import { SettingsService } from "../components/settings/settings.service.js";
import { errorHandler } from "../lib/http.js";
import { attachRealtime, SocketNotifications } from "./socket.js";

test("profile HTTP updates reach shared-chat peers over Socket.IO without broadcasting", async () => {
	const auth = new AuthService(new InMemoryAuthRepository(), {
		accessTokenSecret: "test-access-secret-at-least-32-characters",
		refreshTokenSecret: "test-refresh-secret-at-least-32-characters",
		accessTokenLifetimeSeconds: 900,
		refreshTokenLifetimeSeconds: 3600,
	});
	const accounts = [];
	for (const name of ["ada", "grace", "alan", "outsider"]) {
		accounts.push(
			await auth.signUp(`${name}@example.com`, "test-password", name),
		);
	}
	const [ada, grace, alan] = accounts;
	const memberships = new Map([
		["private", new Set([ada.user.id, grace.user.id])],
		["group", new Set([ada.user.id, grace.user.id, alan.user.id])],
	]);
	const repository = new InMemorySettingsRepository(
		new Map([
			[
				ada.user.id,
				{ id: ada.user.id, name: "ada", username: null, avatarKey: null },
			],
		]),
		memberships,
	);
	const app = express();
	const server = createServer(app);
	const io = attachRealtime(server, auth);
	app.use(express.json());
	app.use(
		"/api/settings",
		createSettingsRouter(
			auth,
			new SettingsService(
				repository,
				new MemoryChatStorage(),
				new SocketNotifications(io),
			),
		),
	);
	app.use(errorHandler);
	const clients: Socket[] = [];
	const received: unknown[][] = accounts.map(() => []);
	try {
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});
		const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		for (const [index, account] of accounts.entries()) {
			const socket = connect(url, {
				auth: { token: account.tokens.accessToken },
				transports: ["websocket"],
				reconnection: false,
				autoConnect: false,
			});
			clients.push(socket);
			socket.on("user.profile_updated", (event) => received[index].push(event));
			await new Promise<void>((resolve, reject) => {
				socket.once("connect", resolve);
				socket.once("connect_error", reject);
				socket.connect();
			});
		}
		async function flushEvents() {
			const delivered = clients.map(
				(client) =>
					new Promise<void>((resolve) => client.once("test.barrier", resolve)),
			);
			io.emit("test.barrier");
			await Promise.all(delivered);
		}
		await request(server)
			.patch("/api/settings/profile")
			.auth(ada.tokens.accessToken, { type: "bearer" })
			.send({ name: "Ada King", username: "ada_king" })
			.expect(200);
		await flushEvents();
		const event = { userId: ada.user.id, changedFields: ["name", "username"] };
		expect(received).toEqual([[], [event], [event], []]);

		const image = await sharp({
			create: { width: 20, height: 20, channels: 4, background: "#000000" },
		})
			.png()
			.toBuffer();
		await request(server)
			.put("/api/settings/avatar")
			.auth(ada.tokens.accessToken, { type: "bearer" })
			.attach("avatar", image, {
				filename: "avatar.png",
				contentType: "image/png",
			})
			.expect(200);
		await flushEvents();
		const avatarEvent = { userId: ada.user.id, changedFields: ["avatar"] };
		expect(received).toEqual([
			[],
			[event, avatarEvent],
			[event, avatarEvent],
			[],
		]);

		memberships.get("private")!.delete(grace.user.id);
		memberships.get("group")!.delete(grace.user.id);
		await request(server)
			.patch("/api/settings/profile")
			.auth(ada.tokens.accessToken, { type: "bearer" })
			.send({ username: "new_ada" })
			.expect(200);
		await flushEvents();
		expect(received[1]).toHaveLength(2);
		expect(received[2]).toHaveLength(3);
		expect(received[0]).toEqual([]);
		expect(received[3]).toEqual([]);
	} finally {
		for (const client of clients) client.disconnect();
		await new Promise<void>((resolve) => io.close(() => resolve()));
	}
});
