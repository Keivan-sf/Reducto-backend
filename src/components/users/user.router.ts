import { Router } from "express";
import { z } from "zod";
import { HttpError } from "../../lib/http.js";
import type { AuthService } from "../auth/auth.service.js";
import { requireAuth } from "../auth/auth.middleware.js";
import type { UserService } from "./user.service.js";

const usernameSchema = z
	.string()
	.min(1)
	.max(32)
	.regex(/^[A-Za-z0-9_]+$/)
	.toLowerCase();

export function createUserRouter(auth: AuthService, service: UserService) {
	const router = Router();
	router.use(requireAuth(auth));
	router.get("/by-username/:username", async (request, response, next) => {
		try {
			const username = usernameSchema.safeParse(request.params.username);
			if (!username.success) throw new HttpError(400, "Invalid username");
			response.setHeader("Cache-Control", "no-store");
			response.json({ user: await service.getByUsername(username.data) });
		} catch (error) {
			next(error);
		}
	});
	router.get("/:userId", async (request, response, next) => {
		try {
			const id = z.uuid().toLowerCase().safeParse(request.params.userId);
			if (!id.success) throw new HttpError(400, "Invalid user ID");
			response.setHeader("Cache-Control", "no-store");
			response.json({ user: await service.getById(id.data) });
		} catch (error) {
			next(error);
		}
	});
	return router;
}
