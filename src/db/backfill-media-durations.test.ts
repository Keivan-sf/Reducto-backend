import { expect, jest, test } from "@jest/globals";
import type { Pool } from "pg";
import { backfillMediaDurations } from "./backfill-media-durations.js";

test("duration backfill resumes failed files and validates only after completion", async () => {
	const records = [
		{ id: "a", object_key: "media/a", duration_seconds: 0 as number | null },
		{ id: "b", object_key: "media/b", duration_seconds: null as number | null },
		{ id: "c", object_key: "media/c", duration_seconds: 0 as number | null },
	];
	const validated: string[] = [];
	const query = async (sql: string, values?: unknown[]) => {
		if (sql.startsWith("SELECT"))
			return {
				rows: records.filter(
					(row) =>
						(row.duration_seconds === 0 || row.duration_seconds === null) &&
						(!values?.[0] || row.id > String(values[0])),
				),
			};
		if (sql.startsWith("UPDATE")) {
			const row = records.find((entry) => entry.id === values![1])!;
			row.duration_seconds = values![0] as number;
			return { rowCount: 1 };
		}
		validated.push(sql);
		return {};
	};
	const database = { query } as unknown as Pick<Pool, "query">;
	let unavailable = true;
	const getObject = jest.fn(async (key: string) => {
		if (key === "media/b" && unavailable) throw new Error("Missing object");
		return Buffer.from(key);
	});
	const read = jest.fn(async (_bytes: Buffer) => 2.5);
	const onError = jest.fn();
	const run = () =>
		backfillMediaDurations(database, { getObject }, { read }, onError);
	expect(await run()).toEqual({ updated: 2, failed: 1 });
	expect(validated).toHaveLength(0);
	expect(records[1].duration_seconds).toBeNull();
	expect(onError).toHaveBeenCalledWith("b", expect.any(Error));
	unavailable = false;
	getObject.mockClear();
	expect(await run()).toEqual({ updated: 1, failed: 0 });
	expect(getObject).toHaveBeenCalledTimes(1);
	expect(getObject).toHaveBeenCalledWith("media/b");
	expect(validated).toEqual([
		'ALTER TABLE "conversation_media" VALIDATE CONSTRAINT "conversation_media_duration_required"',
	]);
	expect(records.every((row) => row.duration_seconds === 2.5)).toBe(true);
	getObject.mockClear();
	expect(await run()).toEqual({ updated: 0, failed: 0 });
	expect(getObject).not.toHaveBeenCalled();
});
