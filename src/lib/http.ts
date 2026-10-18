import type { NextFunction, Request, Response } from "express";
import { MulterError } from "multer";
import type { ZodType } from "zod";

export class HttpError extends Error {
	constructor(
		public readonly status: number,
		message: string,
	) {
		super(message);
	}
}

export function validateBody<T>(schema: ZodType<T>) {
	return (request: Request, response: Response, next: NextFunction) => {
		const parsed = schema.safeParse(request.body);
		if (!parsed.success) {
			response
				.status(400)
				.json({ error: "Invalid request body", details: parsed.error.issues });
			return;
		}
		request.body = parsed.data;
		next();
	};
}

export function errorHandler(
	error: unknown,
	_request: Request,
	response: Response,
	_next: NextFunction,
) {
	if (error instanceof MulterError) {
		response
			.status(400)
			.json({ error: "Uploaded file exceeds the permitted size" });
		return;
	}
	if (error instanceof HttpError) {
		response.status(error.status).json({ error: error.message });
		return;
	}
	console.error(error);
	response.status(500).json({ error: "Internal server error" });
}
