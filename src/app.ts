import express from "express";
import { errorHandler } from "./lib/http.js";
import { createAuthRouter } from "./components/auth/auth.router.js";
import type { AuthService } from "./components/auth/auth.service.js";

export function createApp(authService: AuthService) {
	const app = express();
	app.use(express.json({ limit: "1mb" }));
	app.get("/health", (_request, response) => response.json({ status: "ok" }));
	app.get("/openapi.json", (_request, response) =>
		response.json({
			openapi: "3.0.3",
			info: { title: "Reducto API", version: "1.0.0" },
			paths: {
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
			},
			components: {
				securitySchemes: {
					bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
				},
			},
		}),
	);
	app.use("/api/auth", createAuthRouter(authService));
	app.use(errorHandler);
	return app;
}
