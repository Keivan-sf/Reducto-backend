import { expect, test } from "@jest/globals";
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { errorHandler } from "../../lib/http.js";
import { S3ObjectStorage } from "../../lib/object-storage.js";
import { InMemoryAuthRepository } from "../auth/auth.repository.js";
import { AuthService } from "../auth/auth.service.js";
import type { UserRepository, UserProfileRecord } from "./user.repository.js";
import { UserService, type AvatarUrls } from "./user.service.js";
import { createUserRouter } from "./user.router.js";

class MemoryUsers implements UserRepository {
	constructor(readonly records: UserProfileRecord[]) {}
	async findById(id: string) {
		return this.records.find((user) => user.id === id);
	}
	async findByUsername(username: string) {
		return this.records.find((user) => user.username === username);
	}
}

class MemoryAvatarUrls implements AvatarUrls {
	readonly keys: string[] = [];
	async getAvatarUrl(key: string) {
		this.keys.push(key);
		return `https://storage.example/${key}?signed=true`;
	}
}

test("basic details resolve case-insensitive usernames and IDs without exposing private fields", async () => {
	const record = {
		id: randomUUID(),
		name: "Ada Lovelace",
		username: "ada_123",
		avatarKey: "avatars/ada/picture.png",
		email: "private@example.com",
		passwordHash: "private-hash",
	};
	const urls = new MemoryAvatarUrls();
	const service = new UserService(new MemoryUsers([record]), urls);
	const result = await service.getByUsername("AdA_123");
	expect(result).toEqual({
		id: record.id,
		name: record.name,
		username: record.username,
		avatarUrl: "https://storage.example/avatars/ada/picture.png?signed=true",
	});
	expect(await service.getById(record.id)).toEqual(result);
	expect(urls.keys).toEqual([record.avatarKey, record.avatarKey]);
});

test("profiles without an avatar or username return null and missing users return 404", async () => {
	const record = {
		id: randomUUID(),
		name: "Ada",
		username: null,
		avatarKey: null,
	};
	const urls = new MemoryAvatarUrls();
	const service = new UserService(new MemoryUsers([record]), urls);
	expect(await service.getById(record.id)).toEqual({
		id: record.id,
		name: "Ada",
		username: null,
		avatarUrl: null,
	});
	expect(urls.keys).toEqual([]);
	await expect(service.getById(randomUUID())).rejects.toMatchObject({
		status: 404,
	});
	await expect(service.getByUsername("unknown")).rejects.toMatchObject({
		status: 404,
	});
});

test("profile lookup HTTP routes require authentication and validate lookup parameters", async () => {
	const auth = new AuthService(new InMemoryAuthRepository(), {
		accessTokenSecret: "test-access-secret-at-least-32-characters",
		refreshTokenSecret: "test-refresh-secret-at-least-32-characters",
		accessTokenLifetimeSeconds: 900,
		refreshTokenLifetimeSeconds: 3600,
	});
	const signedIn = await auth.signUp(
		"viewer@example.com",
		"test-password",
		"Viewer",
	);
	const record = {
		id: randomUUID(),
		name: "Another User",
		username: "another_user",
		avatarKey: null,
	};
	const app = express();
	app.use(
		"/api/users",
		createUserRouter(
			auth,
			new UserService(new MemoryUsers([record]), new MemoryAvatarUrls()),
		),
	);
	app.use(errorHandler);
	for (const path of [
		`/api/users/${record.id}`,
		"/api/users/by-username/ANOTHER_USER",
	]) {
		await request(app).get(path).expect(401);
		await request(app)
			.get(path)
			.auth("invalid", { type: "bearer" })
			.expect(401);
		const result = await request(app)
			.get(path)
			.auth(signedIn.tokens.accessToken, { type: "bearer" })
			.expect(200);
		expect(result.body.user).toEqual({
			id: record.id,
			name: record.name,
			username: record.username,
			avatarUrl: null,
		});
		expect(result.headers["cache-control"]).toBe("no-store");
	}
	for (const path of [
		"/api/users/not-a-uuid",
		"/api/users/by-username/not-valid",
		"/api/users/by-username/" + "a".repeat(33),
	]) {
		await request(app)
			.get(path)
			.auth(signedIn.tokens.accessToken, { type: "bearer" })
			.expect(400);
	}
	for (const path of [
		`/api/users/${randomUUID()}`,
		"/api/users/by-username/unknown",
	]) {
		await request(app)
			.get(path)
			.auth(signedIn.tokens.accessToken, { type: "bearer" })
			.expect(404);
	}
});

test("avatar URLs are presigned for the configured object for 15 minutes without contacting S3", async () => {
	const storage = new S3ObjectStorage({
		endpoint: "http://localhost:9000",
		bucket: "reducto",
		accessKeyId: "test-access",
		secretAccessKey: "test-secret",
	});
	const url = new URL(await storage.getAvatarUrl("avatars/user/picture.png"));
	expect(url.origin).toBe("http://localhost:9000");
	expect(url.pathname).toBe("/reducto/avatars/user/picture.png");
	expect(url.searchParams.get("X-Amz-Expires")).toBe("900");
	expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[a-f0-9]{64}$/);
});
