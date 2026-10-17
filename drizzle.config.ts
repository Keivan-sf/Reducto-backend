import { defineConfig } from "drizzle-kit";
import { existsSync } from "node:fs";

if (existsSync(".env")) process.loadEnvFile(".env");

export default defineConfig({
	schema: "./src/db/schema.ts",
	out: "./drizzle",
	dialect: "postgresql",
	dbCredentials: {
		url: process.env.DATABASE_URL ?? "postgres://localhost/reducto",
	},
});
