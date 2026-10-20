import { expect, jest, test } from "@jest/globals";
import type { Pool } from "pg";
import sharp from "sharp";
import { backfillVideoThumbnails } from "./backfill-video-thumbnails.js";

test.each(["download", "generate", "storage", "database"])(
	"thumbnail backfill preserves records after %s failures and resumes safely",
	async (stage) => {
		const records = [
			{
				table: "gifs",
				id: "a",
				type: "video",
				object_key: "gifs/a",
				thumbnail_key: null as string | null,
				width: 80 as number | null,
				height: 40 as number | null,
			},
			{
				table: "conversation_media",
				id: "b",
				type: "video",
				object_key: "videos/b",
				thumbnail_key: null as string | null,
				width: null as number | null,
				height: null as number | null,
			},
			{
				table: "conversation_media",
				id: "c",
				type: "video",
				object_key: "videos/c",
				thumbnail_key: null as string | null,
				width: 80 as number | null,
				height: 40 as number | null,
			},
			{
				table: "conversation_media",
				id: "d",
				type: "image",
				object_key: "images/d",
				thumbnail_key: null as string | null,
				width: 80 as number | null,
				height: 40 as number | null,
			},
		];
		let fail = true;
		const validated: string[] = [];
		const query = async (sql: string, values?: unknown[]) => {
			if (sql.startsWith("SELECT")) {
				const table = sql.includes("FROM gifs") ? "gifs" : "conversation_media";
				if (table === "conversation_media")
					expect(sql).toContain("type = 'video'");
				return {
					rows: records
						.filter(
							(row) =>
								row.table === table &&
								row.type === "video" &&
								row.thumbnail_key === null &&
								(!values?.[0] || row.id > String(values[0])),
						)
						.slice(0, 100),
				};
			}
			if (sql.startsWith("UPDATE")) {
				const row = records.find((row) => row.id === values![3])!;
				if (fail && stage === "database" && row.id === "b")
					throw new Error("Database unavailable");
				row.thumbnail_key = values![0] as string;
				row.width ??= values![1] as number;
				row.height ??= values![2] as number;
				return { rowCount: 1 };
			}
			validated.push(sql);
			return {};
		};
		const database = { query } as unknown as Pick<Pool, "query">;
		const jpeg = await sharp({
			create: { width: 80, height: 40, channels: 3, background: "red" },
		})
			.jpeg()
			.toBuffer();
		const getObject = jest.fn(async (key: string) => {
			if (fail && stage === "download" && key === "videos/b")
				throw new Error("Missing object");
			return Buffer.from(key);
		});
		const generate = jest.fn(async (bytes: Buffer) => {
			if (fail && stage === "generate" && bytes.toString() === "videos/b")
				throw new Error("Corrupt video");
			return jpeg;
		});
		const objects = new Map<string, Buffer>();
		const putObject = jest.fn(
			async (input: { key: string; body: Buffer; contentType: string }) => {
				if (fail && stage === "storage" && input.key.endsWith("/b.jpg"))
					throw new Error("Storage unavailable");
				expect(input.contentType).toBe("image/jpeg");
				objects.set(input.key, input.body);
			},
		);
		const onError = jest.fn();
		const run = () =>
			backfillVideoThumbnails(
				database,
				{ getObject, putObject },
				{ generate },
				onError,
			);
		expect(await run()).toEqual({ updated: 2, failed: 1 });
		expect(validated).toHaveLength(0);
		expect(records[1].thumbnail_key).toBeNull();
		expect(onError).toHaveBeenCalledWith(
			"conversation_media",
			"b",
			expect.any(Error),
		);
		fail = false;
		getObject.mockClear();
		expect(await run()).toEqual({ updated: 1, failed: 0 });
		expect(getObject).toHaveBeenCalledTimes(1);
		expect(getObject).toHaveBeenCalledWith("videos/b");
		expect(records[1]).toMatchObject({
			width: 80,
			height: 40,
			thumbnail_key: "thumbnails/conversation_media/b.jpg",
		});
		expect(records[3].thumbnail_key).toBeNull();
		expect(validated).toHaveLength(2);
		expect(objects.size).toBe(3);
		getObject.mockClear();
		expect(await run()).toEqual({ updated: 0, failed: 0 });
		expect(getObject).not.toHaveBeenCalled();
		expect(records.map((row) => row.object_key)).toEqual([
			"gifs/a",
			"videos/b",
			"videos/c",
			"images/d",
		]);
	},
);
