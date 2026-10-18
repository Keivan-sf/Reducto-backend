import express from "express";
import { errorHandler } from "./lib/http.js";
import { createAuthRouter } from "./components/auth/auth.router.js";
import type { AuthService } from "./components/auth/auth.service.js";
import { createSettingsRouter } from "./components/settings/settings.router.js";
import type { SettingsService } from "./components/settings/settings.service.js";
import { createGifRouter } from "./components/gifs/gif.router.js";
import type { GifService } from "./components/gifs/gif.service.js";
import { createConversationRouter } from "./components/conversations/conversation.router.js";
import { createGroupRouter } from "./components/groups/group.router.js";
import type { ConversationService } from "./components/conversations/conversation.service.js";
import {
	chatPaths,
	chatSchemas,
} from "./components/conversations/conversation.openapi.js";

export function createApp(
	authService: AuthService,
	settingsService: SettingsService,
	gifService: GifService,
	conversationService: ConversationService,
) {
	const app = express();
	app.use(express.json({ limit: "1mb" }));
	app.get("/health", (_request, response) => response.json({ status: "ok" }));
	app.get("/openapi.json", (_request, response) =>
		response.json({
			openapi: "3.0.3",
			info: { title: "Reducto API", version: "1.0.0" },
			paths: {
				...chatPaths,
				"/api/auth/sign-up": { post: { summary: "Create an account" } },
				"/api/auth/sign-in": { post: { summary: "Sign in" } },
				"/api/auth/refresh": { post: { summary: "Rotate a refresh token" } },
				"/api/auth/sign-out": { post: { summary: "Revoke a refresh token" } },
				"/api/auth/me": {
					get: {
						summary: "Get the current user",
						security: [{ bearerAuth: [] }],
					},
				},
				"/api/settings/profile": {
					patch: {
						summary: "Update the authenticated user's name or username",
						security: [{ bearerAuth: [] }],
					},
				},
				"/api/settings/avatar": {
					put: {
						summary: "Upload a square avatar for the authenticated user",
						security: [{ bearerAuth: [] }],
					},
				},
				"/api/gifs": {
					get: {
						summary: "List the authenticated user's stored GIFs",
						security: [{ bearerAuth: [] }],
					},
					post: {
						summary: "Upload a GIF or video (max 50 MB), stored as muted MP4",
						security: [{ bearerAuth: [] }],
					},
				},
				"/api/gifs/{gifId}": {
					put: {
						summary: "Add an existing GIF to the authenticated user's library",
						security: [{ bearerAuth: [] }],
					},
					delete: {
						summary: "Remove a GIF from the authenticated user's library",
						security: [{ bearerAuth: [] }],
					},
				},
			},
			components: {
				schemas: chatSchemas,
				securitySchemes: {
					bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
				},
			},
		}),
	);
	app.use("/api/auth", createAuthRouter(authService));
	app.use("/api/settings", createSettingsRouter(authService, settingsService));
	app.use("/api/gifs", createGifRouter(authService, gifService));
	app.use(
		"/api/conversations",
		createConversationRouter(authService, conversationService),
	);
	app.use("/api/groups", createGroupRouter(authService, conversationService));
	app.use(errorHandler);
	return app;
}
