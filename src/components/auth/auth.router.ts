import { Router } from "express";
import { z } from "zod";
import { validateBody } from "../../lib/http.js";
import { requireAuth } from "./auth.middleware.js";
import type { AuthService } from "./auth.service.js";

const credentialsSchema = z.object({
	email: z.email(),
	password: z.string().min(8).max(128),
});
const refreshSchema = z.object({ refreshToken: z.string().min(1) });

function publicUser(user: { id: string; email: string; createdAt: Date }) {
	return { id: user.id, email: user.email, createdAt: user.createdAt };
}

export function createAuthRouter(authService: AuthService) {
	const router = Router();
	router.post(
		"/sign-up",
		validateBody(credentialsSchema),
		async (request, response, next) => {
			try {
				const { user, tokens } = await authService.signUp(
					request.body.email,
					request.body.password,
				);
				response.status(201).json({ user: publicUser(user), ...tokens });
			} catch (error) {
				next(error);
			}
		},
	);
	router.post(
		"/sign-in",
		validateBody(credentialsSchema),
		async (request, response, next) => {
			try {
				const { user, tokens } = await authService.signIn(
					request.body.email,
					request.body.password,
				);
				response.json({ user: publicUser(user), ...tokens });
			} catch (error) {
				next(error);
			}
		},
	);
	router.post(
		"/refresh",
		validateBody(refreshSchema),
		async (request, response, next) => {
			try {
				response.json(await authService.refresh(request.body.refreshToken));
			} catch (error) {
				next(error);
			}
		},
	);
	router.post(
		"/sign-out",
		validateBody(refreshSchema),
		async (request, response, next) => {
			try {
				await authService.signOut(request.body.refreshToken);
				response.status(204).end();
			} catch (error) {
				next(error);
			}
		},
	);
	router.get(
		"/me",
		requireAuth(authService),
		async (request, response, next) => {
			try {
				const user = await authService.getUser(request.auth!.userId);
				response.json({ user: publicUser(user) });
			} catch (error) {
				next(error);
			}
		},
	);
	return router;
}
