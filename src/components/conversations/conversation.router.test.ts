import { voiceTestWav } from "../../lib/voice-converter.test-support.js";
import { FfmpegGifConverter } from "../../lib/gif-converter.js";
import sharp from "sharp";
import { expect, jest, test } from "@jest/globals";
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
	repository.usernames.set("alice", alice.user.id);
	repository.usernames.set("bob_123", bob.user.id);
	const storage = new MemoryChatStorage();
	const service = new ConversationService(
		repository,
		storage,
		new MemoryNotifications(),
	);
	const app = express();
	app.use(express.json());
	app.use("/api/conversations", createConversationRouter(auth, service));
	app.use("/api/groups", createGroupRouter(auth, service));
	app.use(errorHandler);
	return { app, alice, bob, outsider, storage, repository };
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
	const sentAttachment = await request(app)
		.post(`${path}/messages`)
		.auth(alice.tokens.accessToken, { type: "bearer" })
		.send({ attachment: { type: "document", mediaId: attachment.id } })
		.expect(201);
	expect(sentAttachment.body.message.attachmentMetadata).toEqual(attachment);
	await request(app)
		.get(`${path}/attachments/${attachment.id}`)
		.auth(bob.tokens.accessToken, { type: "bearer" })
		.expect(200);
	const history = await request(app)
		.get(`${path}/messages?limit=1`)
		.auth(bob.tokens.accessToken, { type: "bearer" })
		.expect(200);
	expect(history.body.messages).toHaveLength(1);
	expect(history.body.messages[0].attachmentMetadata).toEqual(attachment);
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

test("HTTP chats can start by username and send messages without knowing the recipient ID", async () => {
	const { app, alice, bob } = await fixture();
	const endpoint = "/api/conversations/private";
	await request(app).post(endpoint).send({ username: "bob_123" }).expect(401);
	const chat = await request(app)
		.post(endpoint)
		.auth(alice.tokens.accessToken, { type: "bearer" })
		.send({ username: "BoB_123" })
		.expect(200);
	const byId = await request(app)
		.post(endpoint)
		.auth(alice.tokens.accessToken, { type: "bearer" })
		.send({ userId: bob.user.id })
		.expect(200);
	expect(chat.body.conversation.id).toBe(byId.body.conversation.id);
	const message = await request(app)
		.post(`${endpoint}/by-username/BOB_123/messages`)
		.auth(alice.tokens.accessToken, { type: "bearer" })
		.send({ text: "Hello Bob" })
		.expect(201);
	expect(message.body.message.conversationId).toBe(chat.body.conversation.id);
	expect(message.body.message.senderId).toBe(alice.user.id);
	await request(app)
		.post(endpoint)
		.auth(alice.tokens.accessToken, { type: "bearer" })
		.send({ username: "does_not_exist" })
		.expect(404);
	await request(app)
		.post(endpoint)
		.auth(alice.tokens.accessToken, { type: "bearer" })
		.send({ username: "ALICE" })
		.expect(400);
	await request(app)
		.post(endpoint)
		.auth(alice.tokens.accessToken, { type: "bearer" })
		.send({ username: "bob_123", userId: bob.user.id })
		.expect(400);
	await request(app)
		.post(endpoint)
		.auth(alice.tokens.accessToken, { type: "bearer" })
		.send({ username: "bob-123" })
		.expect(400);
	await request(app)
		.post(endpoint)
		.auth(alice.tokens.accessToken, { type: "bearer" })
		.send({})
		.expect(400);
});

test("HTTP replies work through username and conversation routes, with same-chat validation", async () => {
	const { app, alice, bob, outsider } = await fixture();
	const originalResponse = await request(app)
		.post(`/api/conversations/private/${bob.user.id}/messages`)
		.auth(alice.tokens.accessToken, { type: "bearer" })
		.send({ text: "Question" })
		.expect(201);
	const original = originalResponse.body.message;
	const replyResponse = await request(app)
		.post("/api/conversations/private/by-username/ALICE/messages")
		.auth(bob.tokens.accessToken, { type: "bearer" })
		.send({ text: "Answer", replyToMessageId: original.id })
		.expect(201);
	const reply = replyResponse.body.message;
	expect(reply.replyToMessageId).toBe(original.id);
	const base = `/api/conversations/${original.conversationId}/messages`;
	const lookup = await request(app)
		.get(`${base}/${original.id}`)
		.auth(bob.tokens.accessToken, { type: "bearer" })
		.expect(200);
	expect(lookup.body.message.id).toBe(original.id);
	await request(app)
		.get(`${base}/${original.id}`)
		.auth(outsider.tokens.accessToken, { type: "bearer" })
		.expect(403);
	await request(app).get(`${base}/${original.id}`).expect(401);
	await request(app)
		.post(base)
		.auth(alice.tokens.accessToken, { type: "bearer" })
		.send({ text: "Follow-up", replyToMessageId: reply.id })
		.expect(201);
	await request(app)
		.post(base)
		.auth(alice.tokens.accessToken, { type: "bearer" })
		.send({ text: "Invalid", replyToMessageId: "invalid" })
		.expect(400);
	const other = await request(app)
		.post("/api/conversations/private")
		.auth(alice.tokens.accessToken, { type: "bearer" })
		.send({ userId: outsider.user.id })
		.expect(200);
	await request(app)
		.post(`/api/conversations/${other.body.conversation.id}/messages`)
		.auth(alice.tokens.accessToken, { type: "bearer" })
		.send({ text: "Wrong chat", replyToMessageId: original.id })
		.expect(400);
});

test("HTTP message context validates counts and chat access", async () => {
	const { app, alice, bob, outsider } = await fixture();
	const sent = await request(app)
		.post(`/api/conversations/private/${bob.user.id}/messages`)
		.auth(alice.tokens.accessToken, { type: "bearer" })
		.send({ text: "Anchor" })
		.expect(201);
	const original = sent.body.message;
	const base = `/api/conversations/${original.conversationId}/messages/${original.id}/around`;
	const result = await request(app)
		.get(base)
		.auth(bob.tokens.accessToken, { type: "bearer" })
		.expect(200);
	expect(result.body).toEqual({
		message: { ...original, reactions: [] },
		before: [],
		after: [],
		hasMoreBefore: false,
		hasMoreAfter: false,
	});
	await request(app)
		.get(`${base}?before=0&after=0`)
		.auth(bob.tokens.accessToken, { type: "bearer" })
		.expect(200);
	await request(app).get(base).expect(401);
	await request(app)
		.get(base)
		.auth(outsider.tokens.accessToken, { type: "bearer" })
		.expect(403);
	for (const query of [
		"before=101",
		"after=-1",
		"before=1.5",
		"after=invalid",
		"other=1",
	]) {
		await request(app)
			.get(`${base}?${query}`)
			.auth(bob.tokens.accessToken, { type: "bearer" })
			.expect(400);
	}
	await request(app)
		.get(
			`/api/conversations/${original.conversationId}/messages/not-an-id/around`,
		)
		.auth(bob.tokens.accessToken, { type: "bearer" })
		.expect(400);
	await request(app)
		.get(
			`/api/conversations/${original.conversationId}/messages/${crypto.randomUUID()}/around`,
		)
		.auth(bob.tokens.accessToken, { type: "bearer" })
		.expect(404);
});

test("image metadata exposes dimensions without reading the object and enforces chat access", async () => {
	const { app, alice, bob, outsider, storage } = await fixture();
	const created = await request(app)
		.post("/api/conversations/private")
		.auth(alice.tokens.accessToken, { type: "bearer" })
		.send({ userId: bob.user.id })
		.expect(200);
	const conversationId = created.body.conversation.id;
	const base = `/api/conversations/${conversationId}/attachments`;
	const image = await sharp({
		create: { width: 80, height: 50, channels: 3, background: "blue" },
	})
		.png()
		.toBuffer();
	const uploaded = await request(app)
		.post(base)
		.auth(alice.tokens.accessToken, { type: "bearer" })
		.attach("file", image, { filename: "photo.png", contentType: "image/png" })
		.expect(201);
	expect(uploaded.body.attachment).toMatchObject({ width: 80, height: 50 });
	const path = `${base}/${uploaded.body.attachment.id}/metadata`;
	const read = jest.spyOn(storage, "getObject");
	const metadata = await request(app)
		.get(path)
		.auth(bob.tokens.accessToken, { type: "bearer" })
		.expect(200);
	expect(metadata.body.attachment).toEqual(uploaded.body.attachment);
	expect(read).not.toHaveBeenCalled();
	await request(app).get(path).expect(401);
	await request(app)
		.get(path)
		.auth(outsider.tokens.accessToken, { type: "bearer" })
		.expect(403);
	await request(app)
		.get(`${base}/${crypto.randomUUID()}/metadata`)
		.auth(alice.tokens.accessToken, { type: "bearer" })
		.expect(404);
	const other = await request(app)
		.post("/api/conversations/private")
		.auth(alice.tokens.accessToken, { type: "bearer" })
		.send({ userId: outsider.user.id })
		.expect(200);
	await request(app)
		.get(
			`/api/conversations/${other.body.conversation.id}/attachments/${uploaded.body.attachment.id}/metadata`,
		)
		.auth(alice.tokens.accessToken, { type: "bearer" })
		.expect(404);
});

test("video upload and metadata return a first-frame thumbnail URL without fetching the video", async () => {
	const { app, alice, bob, storage } = await fixture();
	const created = await request(app)
		.post("/api/conversations/private")
		.auth(alice.tokens.accessToken, { type: "bearer" })
		.send({ userId: bob.user.id })
		.expect(200);
	const base = `/api/conversations/${created.body.conversation.id}/attachments`;
	const video = await new FfmpegGifConverter().convertToMp4(
		Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64"),
	);
	const uploaded = await request(app)
		.post(base)
		.auth(alice.tokens.accessToken, { type: "bearer" })
		.attach("file", video, { filename: "clip.mp4", contentType: "video/mp4" })
		.expect(201);
	const media = uploaded.body.attachment;
	expect(media.thumbnailUrl).toBe(
		`https://storage.example/${media.thumbnailKey}?signed=true`,
	);
	expect(
		await sharp(storage.objects.get(media.thumbnailKey)!).metadata(),
	).toMatchObject({ format: "jpeg", width: media.width, height: media.height });
	const read = jest.spyOn(storage, "getObject");
	const signer = jest
		.spyOn(storage, "getThumbnailUrl")
		.mockResolvedValue("https://storage.example/refreshed.jpg");
	const metadata = await request(app)
		.get(`${base}/${media.id}/metadata`)
		.auth(bob.tokens.accessToken, { type: "bearer" })
		.expect(200);
	expect(metadata.body.attachment).toMatchObject({
		width: media.width,
		height: media.height,
		thumbnailUrl: "https://storage.example/refreshed.jpg",
	});
	expect(metadata.headers["cache-control"]).toBe("no-store");
	expect(read).not.toHaveBeenCalled();
	expect(signer).toHaveBeenCalledWith(media.thumbnailKey);
});

test("HTTP voice messages upload, send, expose metadata, and download converted Ogg", async () => {
	const { app, alice, bob, outsider, storage } = await fixture();
	const created = await request(app)
		.post("/api/conversations/private")
		.auth(alice.tokens.accessToken, { type: "bearer" })
		.send({ userId: bob.user.id })
		.expect(200);
	const base = `/api/conversations/${created.body.conversation.id}`;
	const source = voiceTestWav();
	await request(app)
		.post(`${base}/attachments`)
		.auth(outsider.tokens.accessToken, { type: "bearer" })
		.field("kind", "voice")
		.attach("file", source, {
			filename: "recording.wav",
			contentType: "audio/wav",
		})
		.expect(403);
	const uploaded = await request(app)
		.post(`${base}/attachments`)
		.auth(alice.tokens.accessToken, { type: "bearer" })
		.field("kind", "voice")
		.attach("file", source, {
			filename: "recording.wav",
			contentType: "audio/wav",
		})
		.expect(201);
	const media = uploaded.body.attachment;
	expect(media).toMatchObject({
		type: "voice",
		contentType: "audio/ogg",
		fileName: "recording.ogg",
		width: null,
		height: null,
		thumbnailUrl: null,
	});
	const stored = storage.objects.get(media.objectKey)!;
	expect(stored.toString("ascii", 0, 4)).toBe("OggS");
	expect(media.fileSize).toBe(stored.length);
	expect(stored.length).toBeLessThan(source.length);
	const sent = await request(app)
		.post(`${base}/messages`)
		.auth(alice.tokens.accessToken, { type: "bearer" })
		.send({ attachment: { type: "voice", mediaId: media.id } })
		.expect(201);
	expect(sent.body.message.attachment).toEqual({
		type: "voice",
		mediaId: media.id,
	});
	const history = await request(app)
		.get(`${base}/messages`)
		.auth(bob.tokens.accessToken, { type: "bearer" })
		.expect(200);
	expect(history.body.messages[0].attachment.type).toBe("voice");
	const metadata = await request(app)
		.get(`${base}/attachments/${media.id}/metadata`)
		.auth(bob.tokens.accessToken, { type: "bearer" })
		.expect(200);
	expect(metadata.body.attachment).toEqual(media);
	const downloaded = await request(app)
		.get(`${base}/attachments/${media.id}`)
		.auth(bob.tokens.accessToken, { type: "bearer" })
		.expect(200);
	expect(downloaded.body).toEqual(stored);
	expect(downloaded.headers["content-disposition"]).toContain("recording.ogg");
	await request(app)
		.post(`${base}/attachments`)
		.auth(alice.tokens.accessToken, { type: "bearer" })
		.field("kind", "voice")
		.attach("file", Buffer.from("invalid"), {
			filename: "bad.mp3",
			contentType: "audio/mpeg",
		})
		.expect(400);
	await request(app)
		.post(`${base}/attachments`)
		.auth(alice.tokens.accessToken, { type: "bearer" })
		.field("kind", "unknown")
		.attach("file", source, {
			filename: "recording.wav",
			contentType: "audio/wav",
		})
		.expect(400);
	expect(storage.objects.size).toBe(1);
});

test("HTTP seen API validates updates and includes caller-specific read state in conversation lists", async () => {
	const { app, alice, bob, outsider, repository } = await fixture();
	const created = await request(app)
		.post("/api/conversations/private")
		.auth(alice.tokens.accessToken, { type: "bearer" })
		.send({ userId: bob.user.id })
		.expect(200);
	const id = created.body.conversation.id;
	const path = `/api/conversations/${id}/seen`;
	const sent = await request(app)
		.post(`/api/conversations/${id}/messages`)
		.auth(bob.tokens.accessToken, { type: "bearer" })
		.send({ text: "Hi Alice" })
		.expect(201);
	const messageId = sent.body.message.id;
	const before = await request(app)
		.get("/api/conversations")
		.auth(alice.tokens.accessToken, { type: "bearer" })
		.expect(200);
	expect(before.body.conversations[0]).toMatchObject({
		id,
		lastSeenMessageId: null,
		unreadCount: 1,
	});
	await request(app).put(path).send({ messageId }).expect(401);
	await request(app)
		.put(path)
		.auth(outsider.tokens.accessToken, { type: "bearer" })
		.send({ messageId })
		.expect(403);
	for (const body of [
		{},
		{ messageId: "bad" },
		{ messageId: null },
		{ messageId, userId: bob.user.id },
	])
		await request(app)
			.put(path)
			.auth(alice.tokens.accessToken, { type: "bearer" })
			.send(body)
			.expect(400);
	const updated = await request(app)
		.put(path)
		.auth(alice.tokens.accessToken, { type: "bearer" })
		.send({ messageId: messageId.toUpperCase() })
		.expect(200);
	expect(updated.body).toEqual({
		lastSeenMessageId: messageId,
		unreadCount: 0,
	});
	const after = await request(app)
		.get("/api/conversations")
		.auth(alice.tokens.accessToken, { type: "bearer" })
		.expect(200);
	expect(after.body.conversations[0]).toMatchObject({
		lastSeenMessageId: messageId,
		unreadCount: 0,
	});
	const bobList = await request(app)
		.get("/api/conversations")
		.auth(bob.tokens.accessToken, { type: "bearer" })
		.expect(200);
	expect(bobList.body.conversations[0]).toMatchObject({
		lastSeenMessageId: null,
		unreadCount: 1,
	});
	const other = await request(app)
		.post("/api/conversations/private")
		.auth(alice.tokens.accessToken, { type: "bearer" })
		.send({ userId: outsider.user.id })
		.expect(200);
	await request(app)
		.put(`/api/conversations/${other.body.conversation.id}/seen`)
		.auth(alice.tokens.accessToken, { type: "bearer" })
		.send({ messageId })
		.expect(400);
	expect(
		repository.members.get(`${id}:${alice.user.id}`)?.lastSeenMessageId,
	).toBe(messageId);
});

test("HTTP first-message lookup handles empty history and preserves ordinary message lookup", async () => {
	const { app, alice, bob, outsider, repository } = await fixture();
	const created = await request(app)
		.post("/api/conversations/private")
		.auth(alice.tokens.accessToken, { type: "bearer" })
		.send({ userId: bob.user.id })
		.expect(200);
	const base = `/api/conversations/${created.body.conversation.id}/messages`;
	await request(app).get(`${base}/first`).expect(401);
	await request(app)
		.get(`${base}/first`)
		.auth(outsider.tokens.accessToken, { type: "bearer" })
		.expect(403);
	const empty = await request(app)
		.get(`${base}/first`)
		.auth(alice.tokens.accessToken, { type: "bearer" })
		.expect(200);
	expect(empty.body).toEqual({ message: null });
	const ids: string[] = [];
	for (const text of ["First", "Second"]) {
		const sent = await request(app)
			.post(base)
			.auth(alice.tokens.accessToken, { type: "bearer" })
			.send({ text })
			.expect(201);
		ids.push(sent.body.message.id);
		repository.messages.get(sent.body.message.id)!.createdAt = new Date(
			ids.length * 1000,
		);
	}
	const first = await request(app)
		.get(`${base}/first`)
		.auth(bob.tokens.accessToken, { type: "bearer" })
		.expect(200);
	expect(first.body.message).toMatchObject({
		id: ids[0],
		text: "First",
		reactions: [],
	});
	const ordinary = await request(app)
		.get(`${base}/${ids[0]}`)
		.auth(bob.tokens.accessToken, { type: "bearer" })
		.expect(200);
	expect(first.body).toEqual(ordinary.body);
	await request(app)
		.get("/api/conversations/not-a-uuid/messages/first")
		.auth(alice.tokens.accessToken, { type: "bearer" })
		.expect(400);
});
