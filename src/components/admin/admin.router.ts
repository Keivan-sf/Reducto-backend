import { Router } from "express";
import { z } from "zod";
import { validateBody } from "../../lib/http.js";
import type { AdminService } from "./admin.service.js";

export function createAdminRouter(service: AdminService) {
	const router = Router();
	router.post(
		"/cleanup",
		validateBody(z.object({ password: z.string().min(1) })),
		async (request, response, next) => {
			try {
				response.setHeader("Cache-Control", "no-store");
				response.json(await service.cleanup(request.body.password));
			} catch (error) {
				next(error);
			}
		},
	);
	return router;
}
