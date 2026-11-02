import { expect, jest, test } from "@jest/globals";
import express from "express";
import request from "supertest";
import { errorHandler } from "../../lib/http.js";
import { createAdminRouter } from "./admin.router.js";
import {
	AdminService,
	CLEANUP_EVENT,
	type CleanupResult,
} from "./admin.service.js";

function fixture(password: string | undefined = "admin-secret") {
	const committed = jest.fn();
	const cleanup = jest.fn(
		async (deleteFiles: (keys: string[]) => Promise<void>) => {
			await deleteFiles([
				"attachments/image",
				"thumbnails/attachments/video",
				"covers/attachments/music",
			]);
			committed();
			return { deletedMessages: 5, deletedAttachments: 3 };
		},
	);
	const deleteObject = jest.fn(async (_key: string) => {});
	const broadcast = jest.fn((_event: string, _payload: CleanupResult) => {
		expect(committed).toHaveBeenCalled();
	});
	const service = new AdminService(
		{ cleanup },
		{ deleteObject },
		password,
		broadcast,
	);
	const app = express();
	app.use(express.json());
	app.use("/api/admin", createAdminRouter(service));
	app.use(errorHandler);
	return { app, service, cleanup, deleteObject, broadcast, committed };
}

test("cleanup authenticates only with the body password and broadcasts after commit", async () => {
	const { app, cleanup, deleteObject, broadcast } = fixture();
	const response = await request(app)
		.post("/api/admin/cleanup")
		.send({ password: "admin-secret" })
		.expect(200);
	expect(response.body).toEqual({
		deletedMessages: 5,
		deletedAttachments: 3,
		completedAt: expect.any(String),
	});
	expect(response.headers["cache-control"]).toBe("no-store");
	expect(cleanup).toHaveBeenCalledTimes(1);
	expect(deleteObject.mock.calls.map(([key]) => key)).toEqual([
		"attachments/image",
		"thumbnails/attachments/video",
		"covers/attachments/music",
	]);
	expect(broadcast).toHaveBeenCalledWith(CLEANUP_EVENT, response.body);
});

test("invalid bodies and passwords never start cleanup, including with a bearer token", async () => {
	const { app, cleanup, broadcast } = fixture();
	for (const body of [{}, { password: "" }, { password: 123 }, []]) {
		await request(app).post("/api/admin/cleanup").send(body).expect(400);
	}
	await request(app)
		.post("/api/admin/cleanup")
		.auth("any-token", { type: "bearer" })
		.send({ password: "wrong" })
		.expect(401);
	expect(cleanup).not.toHaveBeenCalled();
	expect(broadcast).not.toHaveBeenCalled();
});

test("an unset ADMIN_PASSWORD disables cleanup", async () => {
	const { app, cleanup } = fixture("");
	await request(app)
		.post("/api/admin/cleanup")
		.send({ password: "anything" })
		.expect(503);
	expect(cleanup).not.toHaveBeenCalled();
});

test("S3 failure retains records, does not notify, and permits retry", async () => {
	const { app, deleteObject, committed, broadcast } = fixture();
	deleteObject.mockRejectedValueOnce(new Error("storage unavailable"));
	await request(app)
		.post("/api/admin/cleanup")
		.send({ password: "admin-secret" })
		.expect(502);
	expect(committed).not.toHaveBeenCalled();
	expect(broadcast).not.toHaveBeenCalled();
	await request(app)
		.post("/api/admin/cleanup")
		.send({ password: "admin-secret" })
		.expect(200);
	expect(broadcast).toHaveBeenCalledTimes(1);
});

test("overlapping cleanup requests are rejected and database failure does not notify", async () => {
	const { service, cleanup, broadcast } = fixture();
	let reject!: (error: Error) => void;
	cleanup.mockImplementationOnce(
		() =>
			new Promise((_resolve, fail) => {
				reject = fail;
			}),
	);
	const first = service.cleanup("admin-secret");
	await expect(service.cleanup("admin-secret")).rejects.toMatchObject({
		status: 409,
	});
	reject(new Error("database failure"));
	await expect(first).rejects.toThrow("database failure");
	expect(broadcast).not.toHaveBeenCalled();
	await expect(service.cleanup("admin-secret")).resolves.toMatchObject({
		deletedMessages: 5,
	});
});
