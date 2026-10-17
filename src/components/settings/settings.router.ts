import multer from "multer";
import { Router } from "express";
import { z } from "zod";
import { validateBody } from "../../lib/http.js";
import { requireAuth } from "../auth/auth.middleware.js";
import type { AuthService } from "../auth/auth.service.js";
import {
	MAX_AVATAR_SIZE_BYTES,
	type SettingsService,
} from "./settings.service.js";

const profileSchema = z
	.object({
		name: z.string().trim().min(1).max(100).optional(),
		username: z
			.string()
			.regex(/^[A-Za-z0-9_]+$/)
			.min(1)
			.max(32)
			.nullable()
			.optional(),
	})
	.refine((value) => value.name !== undefined || value.username !== undefined, {
		message: "Provide a name or username",
	});

const upload = multer({
	storage: multer.memoryStorage(),
	limits: { fileSize: MAX_AVATAR_SIZE_BYTES },
});

export function createSettingsRouter(
	authService: AuthService,
	settingsService: SettingsService,
) {
	const router = Router();
	router.patch(
		"/profile",
		requireAuth(authService),
		validateBody(profileSchema),
		async (request, response, next) => {
			try {
				const user = await settingsService.updateProfile(
					request.auth!.userId,
					request.body,
				);
				response.json({ user });
			} catch (error) {
				next(error);
			}
		},
	);
	router.put(
		"/avatar",
		requireAuth(authService),
		upload.single("avatar"),
		async (request, response, next) => {
			try {
				if (!request.file) {
					response.status(400).json({ error: "Avatar file is required" });
					return;
				}
				const user = await settingsService.updateAvatar(
					request.auth!.userId,
					request.file,
				);
				response.json({ user });
			} catch (error) {
				next(error);
			}
		},
	);
	return router;
}
