import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema.js";

export function createDatabase(databaseUrl: string) {
	return drizzle(new Pool({ connectionString: databaseUrl }), { schema });
}
