import { expect, jest, test } from "@jest/globals";
import type { Pool } from "pg";
import { backfillMediaDimensions } from "./backfill-media-dimensions.js";

test("backfill preserves failed records, resumes completed work, and validates only after success", async () => {
	const records = [
		{
			id: "a",
			object_key: "gifs/a",
			type: "video" as const,
			width: null as number | null,
			height: null as number | null,
		},
		{
			id: "b",
			object_key: "gifs/b",
			type: "video" as const,
			width: null as number | null,
			height: null as number | null,
		},
	];
	const validated: string[] = [];
	const query = async (sql: string, values?: unknown[]) => {
		if (sql.startsWith("SELECT"))
			return {
				rows: sql.includes("FROM gifs")
					? records.filter(
							(row) =>
								row.width === null &&
								(!values?.[0] || row.id > String(values[0])),
						)
					: [],
			};
		if (sql.startsWith("UPDATE")) {
			const row = records.find((row) => row.id === values![2])!;
			row.width = values![0] as number;
			row.height = values![1] as number;
			return { rowCount: 1 };
		}
		validated.push(sql);
		return {};
	};
	const database = { query } as unknown as Pick<Pool, "query">;
	let unavailable = true;
	const getObject = jest.fn(async (key: string) => {
		if (key === "gifs/b" && unavailable) throw new Error("Missing object");
		return Buffer.from(key);
	});
	const read = jest.fn(async () => ({ width: 640, height: 360 }));
	const onError = jest.fn();
	expect(
		await backfillMediaDimensions(database, { getObject }, { read }, onError),
	).toEqual({ updated: 1, failed: 1 });
	expect(validated).toHaveLength(0);
	expect(records[1].width).toBeNull();
	expect(onError).toHaveBeenCalledWith("gifs", "b", expect.any(Error));
	unavailable = false;
	getObject.mockClear();
	expect(
		await backfillMediaDimensions(database, { getObject }, { read }, onError),
	).toEqual({ updated: 1, failed: 0 });
	expect(getObject).toHaveBeenCalledTimes(1);
	expect(getObject).toHaveBeenCalledWith("gifs/b");
	expect(validated).toHaveLength(2);
	expect(records).toHaveLength(2);
	expect(records.every((row) => row.width === 640 && row.height === 360)).toBe(
		true,
	);
	getObject.mockClear();
	expect(
		await backfillMediaDimensions(database, { getObject }, { read }, onError),
	).toEqual({ updated: 0, failed: 0 });
	expect(getObject).not.toHaveBeenCalled();
});
