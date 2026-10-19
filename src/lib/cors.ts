import type { CorsOptions } from "cors";

export const corsOptions: CorsOptions = {
	origin: true,
	credentials: true,
	methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
	exposedHeaders: ["Content-Disposition"],
	maxAge: 86400,
};
