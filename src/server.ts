import { z } from "zod";
import { existsSync } from "node:fs";
import { createApp } from "./app.js";
import { createDatabase } from "./db/client.js";
import { DrizzleAuthRepository } from "./components/auth/auth.repository.js";
import { AuthService } from "./components/auth/auth.service.js";

if (existsSync(".env")) process.loadEnvFile(".env");

const environment = z
	.object({
		DATABASE_URL: z.string().url(),
		ACCESS_TOKEN_SECRET: z.string().min(32),
		REFRESH_TOKEN_SECRET: z.string().min(32),
		PORT: z.coerce.number().int().positive().default(3000),
	})
	.parse(process.env);

const service = new AuthService(
	new DrizzleAuthRepository(createDatabase(environment.DATABASE_URL)),
	{
		accessTokenSecret: environment.ACCESS_TOKEN_SECRET,
		refreshTokenSecret: environment.REFRESH_TOKEN_SECRET,
		accessTokenLifetimeSeconds: 15 * 60,
		refreshTokenLifetimeSeconds: 30 * 24 * 60 * 60,
	},
);

createApp(service).listen(environment.PORT, () =>
	console.log(`Reducto API listening on port ${environment.PORT}`),
);
