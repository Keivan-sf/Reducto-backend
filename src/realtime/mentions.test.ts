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

test("group mentions sent through HTTP reach only the recipient's sockets, including forwards and captions", async () => {
	const auth = new AuthService(new InMemoryAuthRepository(), {
		accessTokenSecret: "test-access-secret-at-least-32-characters",
		refreshTokenSecret: "test-refresh-secret-at-least-32-characters",
		accessTokenLifetimeSeconds: 900,
		refreshTokenLifetimeSeconds: 3600,
	});
	const accounts = [];
	for (const name of ["owner", "member", "observer", "outsider"])
		accounts.push(await auth.signUp(`${name}@example.com`, "password", name));
	const [owner, member, observer] = accounts;
	const repository = new MemoryConversationRepository();
	for (const account of accounts) {
		repository.users.add(account.user.id);
		repository.usernames.set(account.user.name, account.user.id);
	}
	const app = express();
	const server = createServer(app);
	const io = attachRealtime(server, auth);
	const service = new ConversationService(
		repository,
		new MemoryChatStorage(),
		new SocketNotifications(io),
	);
	const group = await service.createGroup(owner.user.id, "Mentions");
	await service.addMember(owner.user.id, group.id, member.user.id);
	await service.addMember(owner.user.id, group.id, observer.user.id);
	const privateChat = await service.createPrivate(
		owner.user.id,
		member.user.id,
	);
	app.use(express.json());
	app.use("/api/conversations", createConversationRouter(auth, service));
	app.use(errorHandler);
	const clients: Socket[] = [];
	// A second member connection represents another signed-in device.
	const connections = [...accounts, member];
	const received: unknown[][] = connections.map(() => []);
	try {
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});
		const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		for (const [index, account] of connections.entries()) {
			const socket = connect(url, {
				auth: { token: account.tokens.accessToken },
				transports: ["websocket"],
				reconnection: false,
				autoConnect: false,
			});
			clients.push(socket);
			socket.on("mention.created", (event) => received[index].push(event));
			await new Promise<void>((resolve, reject) => {
				socket.once("connect", resolve);
				socket.once("connect_error", reject);
				socket.connect();
			});
		}
		async function flush() {
			const delivered = clients.map(
				(client) =>
					new Promise<void>((resolve) => client.once("test.barrier", resolve)),
			);
			io.emit("test.barrier");
			await Promise.all(delivered);
		}
		const base = `/api/conversations/${group.id}`;
		const sent = await request(server)
			.post(`${base}/messages`)
			.auth(owner.tokens.accessToken, { type: "bearer" })
			.send({ text: "@MEMBER @member @outsider @missing" })
			.expect(201);
		await flush();
		const event = {
			mention: {
				userId: member.user.id,
				conversationId: group.id,
				messageId: sent.body.message.id,
				seen: false,
			},
		};
		expect(received).toEqual([[], [event], [], [], [event]]);
		await request(server)
			.patch(`${base}/messages/${sent.body.message.id}`)
			.auth(owner.tokens.accessToken, { type: "bearer" })
			.send({ text: "@observer" })
			.expect(200);
		const source = await request(server)
			.post(`/api/conversations/${privateChat.id}/messages`)
			.auth(owner.tokens.accessToken, { type: "bearer" })
			.send({ text: "@member" })
			.expect(201);
		await flush();
		expect(received).toEqual([[], [event], [], [], [event]]);
		const forwarded = await request(server)
			.post(`${base}/forward`)
			.auth(owner.tokens.accessToken, { type: "bearer" })
			.send({ messageId: source.body.message.id })
			.expect(201);
		const attachment = await repository.createMedia({
			conversationId: group.id,
			uploaderId: owner.user.id,
			type: "document",
			objectKey: "documents/test.txt",
			thumbnailKey: null,
			fileName: "test.txt",
			contentType: "text/plain",
			fileSize: 4,
			width: null,
			height: null,
			durationSeconds: null,
		});
		const caption = await request(server)
			.post(`${base}/messages`)
			.auth(owner.tokens.accessToken, { type: "bearer" })
			.send({
				text: "@member",
				attachment: { type: "document", mediaId: attachment.id },
			})
			.expect(201);
		await flush();
		const events = [sent, forwarded, caption].map((result) => ({
			mention: { ...event.mention, messageId: result.body.message.id },
		}));
		expect(received).toEqual([[], events, [], [], events]);
		await service.removeMember(owner.user.id, group.id, member.user.id);
		await request(server)
			.post(`${base}/messages`)
			.auth(owner.tokens.accessToken, { type: "bearer" })
			.send({ text: "@member" })
			.expect(201);
		await flush();
		expect(received).toEqual([[], events, [], [], events]);
	} finally {
		for (const client of clients) client.disconnect();
		await new Promise<void>((resolve) => io.close(() => resolve()));
	}
});
