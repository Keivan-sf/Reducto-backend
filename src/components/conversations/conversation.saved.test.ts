import { expect, test } from "@jest/globals";
import express from "express";
import request from "supertest";
import { errorHandler } from "../../lib/http.js";
import { InMemoryAuthRepository } from "../auth/auth.repository.js";
import { createAuthRouter } from "../auth/auth.router.js";
import { AuthService } from "../auth/auth.service.js";
import { createGroupRouter } from "../groups/group.router.js";
import { createConversationRouter } from "./conversation.router.js";
import { ConversationService } from "./conversation.service.js";
import {
	MemoryChatStorage,
	MemoryConversationRepository,
	MemoryNotifications,
} from "./conversation.test-support.js";

async function fixture() {
	const repository = new MemoryConversationRepository();
	const auth = new AuthService(new InMemoryAuthRepository(repository), {
		accessTokenSecret: "test-access-secret-at-least-32-characters",
		refreshTokenSecret: "test-refresh-secret-at-least-32-characters",
		accessTokenLifetimeSeconds: 900,
		refreshTokenLifetimeSeconds: 3600,
	});
	const notifications = new MemoryNotifications();
	const service = new ConversationService(
		repository,
		new MemoryChatStorage(),
		notifications,
	);
	const app = express();
	app.use(express.json());
	app.use("/api/auth", createAuthRouter(auth));
	app.use("/api/conversations", createConversationRouter(auth, service));
	app.use("/api/groups", createGroupRouter(auth, service));
	app.use(errorHandler);
	const signup = await request(app)
		.post("/api/auth/sign-up")
		.send({
			email: "alice@example.com",
			password: "test-password",
			name: "Alice",
		})
		.expect(201);
	const alice = signup.body;
	const bob = await auth.signUp("bob@example.com", "test-password", "Bob");
	for (const id of [alice.user.id, bob.user.id]) repository.users.add(id);
	const list = await service.listConversations(alice.user.id);
	return {
		app,
		auth,
		alice,
		bob,
		repository,
		notifications,
		service,
		saved: list[0]!,
	};
}

test("signup creates exactly one empty Saved Messages chat with only the account as a member", async () => {
	const { app, alice, bob, repository, saved } = await fixture();
	expect(saved).toMatchObject({
		type: "saved",
		name: "Saved Messages",
		unreadCount: 0,
		lastSeenMessageId: null,
	});
	const list = await request(app)
		.get("/api/conversations")
		.auth(alice.accessToken, { type: "bearer" })
		.expect(200);
	expect(list.body.conversations).toHaveLength(1);
	expect(list.body.conversations[0].id).toBe(saved.id);
	const members = await request(app)
		.get(`/api/conversations/${saved.id}/members`)
		.auth(alice.accessToken, { type: "bearer" })
		.expect(200);
	expect(members.body.members).toHaveLength(1);
	expect(members.body.members[0]).toMatchObject({
		userId: alice.user.id,
		role: "owner",
	});
	const bobList = await request(app)
		.get("/api/conversations")
		.auth(bob.tokens.accessToken, { type: "bearer" })
		.expect(200);
	expect(bobList.body.conversations).toHaveLength(1);
	expect(bobList.body.conversations[0].id).not.toBe(saved.id);
	await request(app)
		.post("/api/auth/sign-up")
		.send({
			email: "alice@example.com",
			password: "test-password",
			name: "Alice",
		})
		.expect(409);
	await request(app)
		.post("/api/auth/sign-in")
		.send({ email: "alice@example.com", password: "test-password" })
		.expect(200);
	expect(repository.conversations.size).toBe(2);
});

test("Saved Messages supports ordinary messages, documents and forwarding while remaining private", async () => {
	const { app, alice, bob, saved, service, notifications } = await fixture();
	const base = `/api/conversations/${saved.id}`;
	const sent = await request(app)
		.post(`${base}/messages`)
		.auth(alice.accessToken, { type: "bearer" })
		.send({ text: "Remember this" })
		.expect(201);
	expect(sent.body.message).toMatchObject({
		conversationId: saved.id,
		senderId: alice.user.id,
		text: "Remember this",
	});
	expect(notifications.events).toEqual([
		expect.objectContaining({
			userIds: [alice.user.id],
			event: "message.created",
		}),
	]);
	const uploaded = await request(app)
		.post(`${base}/attachments`)
		.auth(alice.accessToken, { type: "bearer" })
		.attach("file", Buffer.from("A saved document"), {
			filename: "notes.txt",
			contentType: "text/plain",
		})
		.expect(201);
	await request(app)
		.post(`${base}/messages`)
		.auth(alice.accessToken, { type: "bearer" })
		.send({
			attachment: { type: "document", mediaId: uploaded.body.attachment.id },
		})
		.expect(201);
	const original = await service.sendPrivate(bob.user.id, alice.user.id, {
		text: "Save me",
	});
	await request(app)
		.post(`${base}/forward`)
		.auth(alice.accessToken, { type: "bearer" })
		.send({ messageId: original.id })
		.expect(201);
	const history = await request(app)
		.get(`${base}/messages`)
		.auth(alice.accessToken, { type: "bearer" })
		.expect(200);
	expect(history.body.messages).toHaveLength(3);
	for (const path of [
		base,
		`${base}/members`,
		`${base}/messages`,
		`${base}/attachments/${uploaded.body.attachment.id}`,
	]) {
		await request(app)
			.get(path)
			.auth(bob.tokens.accessToken, { type: "bearer" })
			.expect(403);
	}
	await request(app)
		.post(`${base}/messages`)
		.auth(bob.tokens.accessToken, { type: "bearer" })
		.send({ text: "Intrusion" })
		.expect(403);
	await request(app)
		.post(`${base}/forward`)
		.auth(bob.tokens.accessToken, { type: "bearer" })
		.send({ messageId: original.id })
		.expect(403);
	const results = await service.searchMessages(bob.user.id, "Remember", 50);
	expect(results.messages).toEqual([]);
});

test("all conversation management routes reject Saved Messages without changing it", async () => {
	const { app, alice, bob, saved, repository } = await fixture();
	const base = `/api/groups/${saved.id}`;
	await request(app)
		.patch(base)
		.auth(alice.accessToken, { type: "bearer" })
		.send({ name: "Renamed" })
		.expect(400);
	await request(app)
		.delete(base)
		.auth(alice.accessToken, { type: "bearer" })
		.expect(400);
	await request(app)
		.get(`${base}/invite`)
		.auth(alice.accessToken, { type: "bearer" })
		.expect(400);
	await request(app)
		.post(`${base}/leave`)
		.auth(alice.accessToken, { type: "bearer" })
		.expect(400);
	await request(app)
		.post(`${base}/members`)
		.auth(alice.accessToken, { type: "bearer" })
		.send({ userId: bob.user.id })
		.expect(400);
	await request(app)
		.patch(`${base}/members/${alice.user.id}`)
		.auth(alice.accessToken, { type: "bearer" })
		.send({ role: "member" })
		.expect(400);
	await request(app)
		.delete(`${base}/members/${alice.user.id}`)
		.auth(alice.accessToken, { type: "bearer" })
		.expect(400);
	expect(await repository.getConversation(saved.id)).toMatchObject({
		type: "saved",
		name: "Saved Messages",
		inviteToken: null,
		savedMessagesOwnerId: alice.user.id,
	});
	expect(await repository.listMembers(saved.id)).toEqual([
		expect.objectContaining({ userId: alice.user.id, role: "owner" }),
	]);
});
