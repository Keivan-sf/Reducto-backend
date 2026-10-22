import { expect, test } from "@jest/globals";
import express from "express";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { io as connect, type Socket } from "socket.io-client";
import request from "supertest";
import { AuthService } from "../components/auth/auth.service.js";
import { InMemoryAuthRepository } from "../components/auth/auth.repository.js";
import { createConversationRouter } from "../components/conversations/conversation.router.js";
import { ConversationService } from "../components/conversations/conversation.service.js";
import {
	MemoryChatStorage,
	MemoryConversationRepository,
} from "../components/conversations/conversation.test-support.js";
import { errorHandler } from "../lib/http.js";
import { attachRealtime, SocketNotifications } from "./socket.js";

test("seen HTTP changes notify all other current members over Socket.IO", async () => {
	const auth = new AuthService(new InMemoryAuthRepository(), {
		accessTokenSecret: "test-access-secret-at-least-32-characters",
		refreshTokenSecret: "test-refresh-secret-at-least-32-characters",
		accessTokenLifetimeSeconds: 900,
		refreshTokenLifetimeSeconds: 3600,
	});
	const accounts = [];
	for (const name of ["owner", "member", "removed", "outsider"])
		accounts.push(await auth.signUp(`${name}@example.com`, "password", name));
	const [owner, member, removed] = accounts;
	const repository = new MemoryConversationRepository();
	for (const account of accounts) repository.users.add(account.user.id);
	const app = express();
	const server = createServer(app);
	const io = attachRealtime(server, auth);
	const service = new ConversationService(
		repository,
		new MemoryChatStorage(),
		new SocketNotifications(io),
	);
	const group = await service.createGroup(owner.user.id, "Read receipts");
	await service.addMember(owner.user.id, group.id, member.user.id);
	await service.addMember(owner.user.id, group.id, removed.user.id);
	const first = await service.sendMessage(member.user.id, group.id, {
		text: "First",
	});
	const second = await service.sendMessage(member.user.id, group.id, {
		text: "Second",
	});
	repository.messages.get(first.id)!.createdAt = new Date(1000);
	repository.messages.get(second.id)!.createdAt = new Date(2000);
	app.use(express.json());
	app.use("/api/conversations", createConversationRouter(auth, service));
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
			socket.on("conversation.seen", (event) => received[index].push(event));
			await new Promise<void>((resolve, reject) => {
				socket.once("connect", resolve);
				socket.once("connect_error", reject);
				socket.connect();
			});
		}
		async function update(messageId: string) {
			await request(server)
				.put(`/api/conversations/${group.id}/seen`)
				.auth(owner.tokens.accessToken, { type: "bearer" })
				.send({ messageId })
				.expect(200);
			const delivered = clients.map(
				(client) =>
					new Promise<void>((resolve) => client.once("test.barrier", resolve)),
			);
			io.emit("test.barrier");
			await Promise.all(delivered);
		}
		await update(first.id);
		const event = {
			userId: owner.user.id,
			conversationId: group.id,
			lastSeenMessageId: first.id,
		};
		expect(received).toEqual([[], [event], [event], []]);
		await service.removeMember(owner.user.id, group.id, removed.user.id);
		await update(second.id);
		expect(received).toEqual([
			[],
			[event, { ...event, lastSeenMessageId: second.id }],
			[event],
			[],
		]);
		await update(second.id);
		await update(first.id);
		expect(received.map((events) => events.length)).toEqual([0, 2, 1, 0]);
	} finally {
		for (const client of clients) client.disconnect();
		await new Promise<void>((resolve) => io.close(() => resolve()));
	}
});
