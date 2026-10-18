import { expect, test } from "@jest/globals";
import express from "express";
import request from "supertest";
import { errorHandler } from "../../lib/http.js";
import { InMemoryAuthRepository } from "../auth/auth.repository.js";
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
		"outsider@example.com",
		"test-password",
		"Outsider",
	);
	const repository = new MemoryConversationRepository();
	for (const account of [alice, bob, outsider])
		repository.users.add(account.user.id);
	const service = new ConversationService(
		repository,
		new MemoryChatStorage(),
		new MemoryNotifications(),
	);
	const app = express();
	app.use(express.json());
	app.use("/api/conversations", createConversationRouter(auth, service));
	app.use("/api/groups", createGroupRouter(auth, service));
	app.use(errorHandler);
	return { app, alice, bob, outsider };
}

test("HTTP messaging enforces authentication, membership, validated bodies, and attachment ownership", async () => {
	const { app, alice, bob, outsider } = await fixture();
	await request(app).get("/api/conversations").expect(401);
	const response = await request(app)
		.post(`/api/conversations/private/${bob.user.id}/messages`)
		.auth(alice.tokens.accessToken, { type: "bearer" })
		.send({ text: "Hello Bob" })
		.expect(201);
	const conversationId = response.body.message.conversationId;
	const path = `/api/conversations/${conversationId}`;
	await request(app)
		.get(`${path}/messages`)
		.auth(outsider.tokens.accessToken, { type: "bearer" })
		.expect(403);
	await request(app)
		.post(`${path}/messages`)
		.auth(alice.tokens.accessToken, { type: "bearer" })
		.send({ text: "forged", senderId: bob.user.id })
		.expect(400);
	const uploaded = await request(app)
		.post(`${path}/attachments`)
		.auth(alice.tokens.accessToken, { type: "bearer" })
		.attach("file", Buffer.from("notes"), {
			filename: "notes.txt",
			contentType: "text/plain",
		})
		.expect(201);
	const attachment = uploaded.body.attachment;
	expect(attachment.type).toBe("document");
	await request(app)
		.post(`${path}/messages`)
		.auth(alice.tokens.accessToken, { type: "bearer" })
		.send({ attachment: { type: "document", mediaId: attachment.id } })
		.expect(201);
	await request(app)
		.get(`${path}/attachments/${attachment.id}`)
		.auth(bob.tokens.accessToken, { type: "bearer" })
		.expect(200);
	const history = await request(app)
		.get(`${path}/messages?limit=1`)
		.auth(bob.tokens.accessToken, { type: "bearer" })
		.expect(200);
	expect(history.body.messages).toHaveLength(1);
	expect(history.body.nextCursor).toBeTruthy();
	await request(app)
		.get(`${path}/messages?limit=10000`)
		.auth(bob.tokens.accessToken, { type: "bearer" })
		.expect(400);
	await request(app)
		.get("/api/conversations/not-a-uuid/messages")
		.auth(bob.tokens.accessToken, { type: "bearer" })
		.expect(400);
});

test("HTTP group invites join the group and only owners grant admin or delete", async () => {
	const { app, alice, bob, outsider } = await fixture();
	const created = await request(app)
		.post("/api/groups")
		.auth(alice.tokens.accessToken, { type: "bearer" })
		.send({ name: "Our group" })
		.expect(201);
	const { id, inviteLink } = created.body.conversation;
	await request(app).get(inviteLink).expect(401);
	await request(app)
		.get(inviteLink)
		.auth(bob.tokens.accessToken, { type: "bearer" })
		.expect(200);
	const base = `/api/groups/${id}`;
	await request(app)
		.patch(`${base}/members/${bob.user.id}`)
		.auth(alice.tokens.accessToken, { type: "bearer" })
		.send({ role: "admin" })
		.expect(204);
	await request(app)
		.post(`${base}/members`)
		.auth(bob.tokens.accessToken, { type: "bearer" })
		.send({ userId: outsider.user.id })
		.expect(204);
	await request(app)
		.patch(`${base}/members/${outsider.user.id}`)
		.auth(bob.tokens.accessToken, { type: "bearer" })
		.send({ role: "admin" })
		.expect(403);
	await request(app)
		.delete(base)
		.auth(bob.tokens.accessToken, { type: "bearer" })
		.expect(403);
	await request(app)
		.delete(base)
		.auth(alice.tokens.accessToken, { type: "bearer" })
		.expect(204);
	await request(app)
		.get(inviteLink)
		.auth(bob.tokens.accessToken, { type: "bearer" })
		.expect(404);
});
