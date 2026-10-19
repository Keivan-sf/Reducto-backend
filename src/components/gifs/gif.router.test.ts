import { expect, test } from "@jest/globals";
import express from "express";
import request from "supertest";
import { errorHandler } from "../../lib/http.js";
import { S3ObjectStorage } from "../../lib/object-storage.js";
import { InMemoryAuthRepository } from "../auth/auth.repository.js";
import { AuthService } from "../auth/auth.service.js";
import { InMemoryGifRepository } from "./gif.repository.js";
import { createGifRouter } from "./gif.router.js";
import { GifService, type GifObjectStorage } from "./gif.service.js";

test("authenticated GIF responses include playable links on upload, library listing, and lookup by ID", async () => {
	const auth = new AuthService(new InMemoryAuthRepository(), {
		accessTokenSecret: "test-access-secret-at-least-32-characters",
		refreshTokenSecret: "test-refresh-secret-at-least-32-characters",
		accessTokenLifetimeSeconds: 900,
		refreshTokenLifetimeSeconds: 3600,
	});
	const owner = await auth.signUp(
		"owner@example.com",
		"test-password",
		"Owner",
	);
	const viewer = await auth.signUp(
		"viewer@example.com",
		"test-password",
		"Viewer",
	);
	const storage: GifObjectStorage = {
		async putObject() {},
		async deleteObject() {},
		async getPlaybackUrl(key) {
			return `https://storage.example/${key}?signed=true`;
		},
	};
	const service = new GifService(
		new InMemoryGifRepository(new Set([owner.user.id, viewer.user.id])),
		storage,
		{
			async convertToMp4() {
				return Buffer.from("mp4");
			},
		},
	);
	const app = express();
	app.use("/api/gifs", createGifRouter(auth, service));
	app.use(errorHandler);
	const uploaded = await request(app)
		.post("/api/gifs")
		.auth(owner.tokens.accessToken, { type: "bearer" })
		.attach("gif", Buffer.from("video"), {
			filename: "clip.webm",
			contentType: "video/webm",
		})
		.expect(201);
	const gif = uploaded.body.gif;
	expect(gif.playbackUrl).toBe(
		`https://storage.example/${gif.objectKey}?signed=true`,
	);
	expect(gif.objectKey).toMatch(/\.mp4$/);
	const library = await request(app)
		.get("/api/gifs")
		.auth(owner.tokens.accessToken, { type: "bearer" })
		.expect(200);
	expect(library.body.gifs).toEqual([gif]);
	const details = await request(app)
		.get(`/api/gifs/${gif.id}`)
		.auth(viewer.tokens.accessToken, { type: "bearer" })
		.expect(200);
	expect(details.body.gif).toEqual(gif);
	expect(details.headers["cache-control"]).toBe("no-store");
	const viewerLibrary = await request(app)
		.get("/api/gifs")
		.auth(viewer.tokens.accessToken, { type: "bearer" })
		.expect(200);
	expect(viewerLibrary.body.gifs).toEqual([]);
	await request(app).get(`/api/gifs/${gif.id}`).expect(401);
	await request(app)
		.get("/api/gifs/not-a-uuid")
		.auth(owner.tokens.accessToken, { type: "bearer" })
		.expect(400);
	await request(app)
		.get(`/api/gifs/${crypto.randomUUID()}`)
		.auth(owner.tokens.accessToken, { type: "bearer" })
		.expect(404);
});

test("MP4 playback links sign the stored object with inline video headers and a 15-minute expiry", async () => {
	const storage = new S3ObjectStorage({
		endpoint: "http://localhost:9000",
		bucket: "reducto",
		accessKeyId: "test-access",
		secretAccessKey: "test-secret",
	});
	const url = new URL(await storage.getPlaybackUrl("gifs/user/clip.mp4"));
	expect(url.pathname).toBe("/reducto/gifs/user/clip.mp4");
	expect(url.searchParams.get("X-Amz-Expires")).toBe("900");
	expect(url.searchParams.get("response-content-type")).toBe("video/mp4");
	expect(url.searchParams.get("response-content-disposition")).toBe("inline");
	expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[a-f0-9]{64}$/);
});
