import { expect, test } from "@jest/globals";
import express from "express";
import request from "supertest";
import sharp from "sharp";
import { InMemoryAuthRepository } from "../components/auth/auth.repository.js";
import { AuthService } from "../components/auth/auth.service.js";
import { createAuthRouter } from "../components/auth/auth.router.js";
import { ConversationService } from "../components/conversations/conversation.service.js";
import { createConversationRouter } from "../components/conversations/conversation.router.js";
import {
	MemoryChatStorage,
	MemoryConversationRepository,
	MemoryNotifications,
} from "../components/conversations/conversation.test-support.js";
import {
	InMemorySettingsRepository,
	type SettingsUser,
} from "../components/settings/settings.repository.js";
import { SettingsService } from "../components/settings/settings.service.js";
import { createSettingsRouter } from "../components/settings/settings.router.js";
import { UserService } from "../components/users/user.service.js";
import { createUserRouter } from "../components/users/user.router.js";
import { errorHandler } from "../lib/http.js";
import { PresenceService } from "./presence.js";

test("all user HTTP responses include live presence and saved last_seen, including conversation members", async () => {
	const authRepository = new InMemoryAuthRepository();
	const auth = new AuthService(authRepository, {
		accessTokenSecret: "test-access-secret-at-least-32-characters",
		refreshTokenSecret: "test-refresh-secret-at-least-32-characters",
		accessTokenLifetimeSeconds: 900,
		refreshTokenLifetimeSeconds: 3600,
	});
	const alice = await auth.signUp(
		"alice@example.com",
		"test-password",
		"Alice",
		"alice",
	);
	const bob = await auth.signUp("bob@example.com", "test-password", "Bob");
	const outsider = await auth.signUp(
		"outsider@example.com",
		"test-password",
		"Other",
	);
	const chats = new MemoryConversationRepository();
	for (const account of [alice, bob, outsider])
		chats.users.add(account.user.id);
	const privateChat = await chats.createPrivate([alice.user.id, bob.user.id]);
	const group = await chats.createGroup(alice.user.id, "Group", "invite");
	await chats.addMember(group.id, bob.user.id);
	const profiles = new Map<string, SettingsUser>(
		[alice, bob, outsider].map(({ user }) => [
			user.id,
			{
				id: user.id,
				name: user.name,
				username: user.username,
				avatarKey: null,
			},
		]),
	);
	const storage = new MemoryChatStorage();
	const notifications = new MemoryNotifications();
	let now = Date.now();
	const presence = new PresenceService(
		{
			async saveLastSeen(entries) {
				for (const [id, time] of entries) {
					profiles.get(id)!.lastSeen = new Date(time);
					(await authRepository.findUserById(id))!.lastSeen = new Date(time);
					for (const member of chats.members.values()) {
						if (member.userId === id) member.lastSeen = new Date(time);
					}
				}
			},
			async findConversationPeerIds() {
				return [];
			},
		},
		notifications,
		() => now,
	);
	const users = new UserService(
		{
			async findById(id) {
				return profiles.get(id);
			},
			async findByUsername(username) {
				return [...profiles.values()].find(
					(user) => user.username === username,
				);
			},
		},
		{
			async getAvatarUrl(key) {
				return `https://storage.example/${key}`;
			},
		},
		presence,
	);
	const conversations = new ConversationService(
		chats,
		storage,
		notifications,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		presence,
	);
	const settings = new SettingsService(
		new InMemorySettingsRepository(profiles),
		storage,
		notifications,
	);
	const app = express();
	app.use(express.json());
	app.use("/api/auth", createAuthRouter(auth, presence));
	app.use("/api/users", createUserRouter(auth, users));
	app.use("/api/settings", createSettingsRouter(auth, settings, presence));
	app.use("/api/conversations", createConversationRouter(auth, conversations));
	app.use(errorHandler);
	const signup = await request(app)
		.post("/api/auth/sign-up")
		.send({ email: "new@example.com", password: "test-password", name: "New" })
		.expect(201);
	expect(signup.body.user).toMatchObject({ online: false, last_seen: null });

	const query = (path: string) =>
		request(app).get(path).auth(alice.tokens.accessToken, { type: "bearer" });
	const lastSeen = new Date(now).toISOString();
	presence.heartbeat(alice.user.id);
	// No tick has occurred yet: every query must already use the live heartbeat.
	for (const path of [
		`/api/users/${alice.user.id}`,
		"/api/users/by-username/ALICE",
		"/api/auth/me",
	]) {
		const result = await query(path).expect(200);
		expect(result.body.user).toMatchObject({
			online: true,
			last_seen: lastSeen,
		});
		expect(result.body.user).not.toHaveProperty("passwordHash");
		expect(result.body.user).not.toHaveProperty("lastSeen");
	}
	for (const chat of [privateChat, group]) {
		await request(app)
			.get(`/api/conversations/${chat.id}/members`)
			.auth(outsider.tokens.accessToken, { type: "bearer" })
			.expect(403);
		const result = await query(`/api/conversations/${chat.id}/members`).expect(
			200,
		);
		expect(result.body.members).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					userId: alice.user.id,
					online: true,
					last_seen: lastSeen,
				}),
				expect.objectContaining({
					userId: bob.user.id,
					online: false,
					last_seen: null,
				}),
			]),
		);
		expect(result.body.members).toHaveLength(2);
		expect(result.body.members[0]).not.toHaveProperty("lastSeen");
	}
	const signin = await request(app)
		.post("/api/auth/sign-in")
		.send({ email: "alice@example.com", password: "test-password" })
		.expect(200);
	expect(signin.body.user).toMatchObject({ online: true, last_seen: lastSeen });
	const updated = await request(app)
		.patch("/api/settings/profile")
		.auth(alice.tokens.accessToken, { type: "bearer" })
		.send({ name: "Alice Updated" })
		.expect(200);
	expect(updated.body.user).toMatchObject({
		online: true,
		last_seen: lastSeen,
	});
	const image = await sharp({
		create: { width: 20, height: 20, channels: 4, background: "#000000" },
	})
		.png()
		.toBuffer();
	const avatar = await request(app)
		.put("/api/settings/avatar")
		.auth(alice.tokens.accessToken, { type: "bearer" })
		.attach("avatar", image, {
			filename: "avatar.png",
			contentType: "image/png",
		})
		.expect(200);
	expect(avatar.body.user).toMatchObject({ online: true, last_seen: lastSeen });
	await presence.tick();
	now += 60_001;
	// Query expiry is accurate even before the next scan.
	expect(
		(await query(`/api/users/${alice.user.id}`).expect(200)).body.user,
	).toMatchObject({ online: false, last_seen: lastSeen });
	await presence.tick();
	for (const path of [
		`/api/users/${alice.user.id}`,
		"/api/users/by-username/ALICE",
		"/api/auth/me",
	]) {
		expect((await query(path).expect(200)).body.user).toMatchObject({
			online: false,
			last_seen: lastSeen,
		});
	}
	const offlineMembers = await query(
		`/api/conversations/${group.id}/members`,
	).expect(200);
	expect(offlineMembers.body.members).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				userId: alice.user.id,
				online: false,
				last_seen: lastSeen,
			}),
		]),
	);
	presence.heartbeat(alice.user.id);
	expect(
		(await query(`/api/users/${alice.user.id}`).expect(200)).body.user,
	).toMatchObject({ online: true, last_seen: new Date(now).toISOString() });
});
