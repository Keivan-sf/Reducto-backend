import type { NextFunction, Request, Response } from "express";
import { HttpError } from "../../lib/http.js";
import type { AuthService } from "./auth.service.js";

declare global {
	namespace Express {
		interface Request {
			auth?: { userId: string };
		}
	}
}

export function requireAuth(authService: AuthService) {
	return (request: Request, _response: Response, next: NextFunction) => {
		const header = request.header("authorization");
		if (!header?.startsWith("Bearer "))
			return next(new HttpError(401, "Bearer token is required"));
		try {
			request.auth = { userId: authService.verifyAccessToken(header.slice(7)) };
			next();
		} catch (error) {
			next(error);
		}
	};
}
