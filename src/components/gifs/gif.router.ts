import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { requireAuth } from "../auth/auth.middleware.js";
import type { AuthService } from "../auth/auth.service.js";
import { MAX_GIF_SIZE_BYTES, type GifService } from "./gif.service.js";

const gifIdSchema = z.object({ gifId: z.uuid() });
const upload = multer({
	storage: multer.memoryStorage(),
	limits: { fileSize: MAX_GIF_SIZE_BYTES },
});

export function createGifRouter(
	authService: AuthService,
	gifService: GifService,
) {
	const router = Router();
	router.put(
		"/:gifId",
		requireAuth(authService),
		async (request, response, next) => {
			try {
				const parsed = gifIdSchema.safeParse(request.params);
				if (!parsed.success) {
					response.status(400).json({ error: "Invalid GIF id" });
					return;
				}
				await gifService.addToLibrary(request.auth!.userId, parsed.data.gifId);
				response.status(204).end();
			} catch (error) {
				next(error);
			}
		},
	);
	router.get("/", requireAuth(authService), async (request, response, next) => {
		try {
			response.setHeader("Cache-Control", "no-store");
			response.json({ gifs: await gifService.listGifs(request.auth!.userId) });
		} catch (error) {
			next(error);
		}
	});
	router.get(
		"/:gifId",
		requireAuth(authService),
		async (request, response, next) => {
			try {
				const parsed = gifIdSchema.safeParse(request.params);
				if (!parsed.success) {
					response.status(400).json({ error: "Invalid GIF id" });
					return;
				}
				response.setHeader("Cache-Control", "no-store");
				response.json({ gif: await gifService.getGif(parsed.data.gifId) });
			} catch (error) {
				next(error);
			}
		},
	);
	router.post(
		"/",
		requireAuth(authService),
		upload.single("gif"),
		async (request, response, next) => {
			try {
				if (!request.file) {
					response.status(400).json({ error: "GIF or video file is required" });
					return;
				}
				response.setHeader("Cache-Control", "no-store");
				response.status(201).json({
					gif: await gifService.uploadGif(request.auth!.userId, request.file),
				});
			} catch (error) {
				next(error);
			}
		},
	);
	router.delete(
		"/:gifId",
		requireAuth(authService),
		async (request, response, next) => {
			try {
				const parsed = gifIdSchema.safeParse(request.params);
				if (!parsed.success) {
					response.status(400).json({ error: "Invalid GIF id" });
					return;
				}
				await gifService.deleteGif(request.auth!.userId, parsed.data.gifId);
				response.status(204).end();
			} catch (error) {
				next(error);
			}
		},
	);
	return router;
}
