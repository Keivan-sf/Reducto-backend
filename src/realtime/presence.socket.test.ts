import { expect, jest, test } from "@jest/globals";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "socket.io";
import { io as connect, type Socket } from "socket.io-client";
import { AuthService } from "../components/auth/auth.service.js";
import { InMemoryAuthRepository } from "../components/auth/auth.repository.js";
import { InMemorySettingsRepository } from "../components/settings/settings.repository.js";
import { PresenceService } from "./presence.js";
import { attachRealtime, SocketNotifications } from "./socket.js";

test("compact authenticated heartbeats notify connected shared-chat peers across devices", async () => {
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
	const outsider = await auth.signUp(
		"other@example.com",
		"test-password",
		"Other",
	);
	const memberships = new Map([
		["private", new Set([alice.user.id, bob.user.id])],
		["group", new Set([alice.user.id, bob.user.id])],
	]);
	const peers = new InMemorySettingsRepository(new Map(), memberships);
	const saved = new Map<string, number>();
	let now = Date.now();
	const server = createServer();
	const io = new Server();
	const presence = new PresenceService(
		{
			async saveLastSeen(entries) {
				for (const [id, time] of entries) saved.set(id, time);
			},
			findConversationPeerIds: (id) => peers.findConversationPeerIds(id),
		},
		new SocketNotifications(io),
		() => now,
	);
	const intervals = jest.spyOn(global, "setInterval");
	const cleared = jest.spyOn(global, "clearInterval");
	attachRealtime(server, auth, io, presence);
	const timerIndex = intervals.mock.calls.findIndex(
		(call) => call[1] === 60_000,
	);
	expect(timerIndex).toBeGreaterThanOrEqual(0);
	expect(
		intervals.mock.calls.filter((call) => call[1] === 60_000),
	).toHaveLength(1);
	const timer = intervals.mock.results[timerIndex].value as ReturnType<
		typeof setInterval
	>;
	io.on("connection", (socket) => {
		socket.on("test.flush", (ack: () => void) => ack());
	});
	const clients: Socket[] = [];
	const received: unknown[][] = [[], [], [], []];
	try {
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});
		const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		for (const [index, account] of [alice, alice, bob, outsider].entries()) {
			const client = connect(url, {
				auth: { token: account.tokens.accessToken },
				transports: ["websocket"],
				reconnection: false,
				autoConnect: false,
			});
			clients.push(client);
			client.on("user.presence", (event) => received[index].push(event));
			await new Promise<void>((resolve, reject) => {
				client.once("connect", resolve);
				client.once("connect_error", reject);
				client.connect();
			});
		}
		async function heartbeat(client: Socket) {
			client.emit("p");
			await new Promise<void>((resolve) => client.emit("test.flush", resolve));
		}
		async function scan() {
			await presence.tick();
			const delivered = [clients[2], clients[3]].map(
				(client) =>
					new Promise<void>((resolve) => client.once("test.barrier", resolve)),
			);
			io.emit("test.barrier");
			await Promise.all(delivered);
		}
		await scan();
		expect(saved.size).toBe(0); // Merely connecting does not count as a heartbeat.
		// Client-provided identity/timestamps are ignored.
		clients[0].emit("p", { userId: outsider.user.id, timestamp: 1 });
		await heartbeat(clients[0]);
		expect(saved.size).toBe(0);
		await scan();
		const online = {
			userId: alice.user.id,
			online: true,
			last_seen: new Date(now).toISOString(),
		};
		expect(received).toEqual([[], [], [online], []]);
		expect(saved.size).toBe(1);
		expect(saved.get(alice.user.id)).toBe(now);
		clients[0].disconnect();
		now += 30_000;
		await heartbeat(clients[1]);
		await scan();
		expect(received[2]).toEqual([online]);
		clients[1].disconnect();
		const lastSeen = new Date(now).toISOString();
		now += 60_001;
		await scan();
		expect(received[2]).toEqual([
			online,
			{ userId: alice.user.id, online: false, last_seen: lastSeen },
		]);
		expect(received[3]).toEqual([]);
		await scan();
		expect(received[2]).toHaveLength(2);
	} finally {
		for (const client of clients) client.disconnect();
		await new Promise<void>((resolve) => io.close(() => resolve()));
		expect(cleared).toHaveBeenCalledWith(timer);
		intervals.mockRestore();
		cleared.mockRestore();
	}
});
