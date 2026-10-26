import { afterEach, expect, jest, test } from "@jest/globals";
import type { Request, Response } from "express";
import multer, { MulterError } from "multer";
import { PassThrough } from "node:stream";
import { errorHandler } from "./http.js";

afterEach(() => {
	jest.restoreAllMocks();
});

function fixture(aborted: boolean) {
	const request = { aborted } as Request;
	const json = jest.fn();
	const status = jest.fn().mockReturnValue({ json });
	const response = { status } as unknown as Response;
	const next = jest.fn();
	const log = jest.spyOn(console, "error").mockImplementation(() => {});
	return { request, response, next, log, status, json };
}

const cancellationErrors = [
	new Error("Request aborted"),
	new Error("Request closed"),
	Object.assign(new Error("aborted"), { code: "ECONNRESET" }),
	Object.assign(new Error("request aborted"), { type: "request.aborted" }),
];

test.each(cancellationErrors)(
	"canceled requests do not log or send an error response: %s",
	(error) => {
		const { request, response, next, log, status } = fixture(true);
		errorHandler(error, request, response, next);
		expect(log).not.toHaveBeenCalled();
		expect(status).not.toHaveBeenCalled();
		expect(next).not.toHaveBeenCalled();
	},
);

test.each(cancellationErrors)(
	"similar errors on active requests remain visible: %s",
	(error) => {
		const { request, response, next, log, status, json } = fixture(false);
		errorHandler(error, request, response, next);
		expect(log).toHaveBeenCalledWith(error);
		expect(status).toHaveBeenCalledWith(500);
		expect(json).toHaveBeenCalledWith({ error: "Internal server error" });
	},
);

test("unrelated failures remain visible even if the client disconnected", () => {
	const { request, response, next, log, status } = fixture(true);
	const error = new Error("Storage unavailable");
	errorHandler(error, request, response, next);
	expect(log).toHaveBeenCalledWith(error);
	expect(status).toHaveBeenCalledWith(500);
});

test("upload size validation still returns a client error", () => {
	const { request, response, next, log, status, json } = fixture(false);
	errorHandler(new MulterError("LIMIT_FILE_SIZE"), request, response, next);
	expect(log).not.toHaveBeenCalled();
	expect(status).toHaveBeenCalledWith(400);
	expect(json).toHaveBeenCalledWith({
		error: "Uploaded file exceeds the permitted size",
	});
});

test("canceling a partial multipart upload stops before the upload handler", async () => {
	const { response, next, log, status } = fixture(true);
	const stream = new PassThrough();
	const request = Object.assign(stream, {
		headers: {
			"content-type": "multipart/form-data; boundary=upload-boundary",
			"content-length": "10000",
		},
		aborted: false,
	}) as unknown as Request;
	const upload = multer({ storage: multer.memoryStorage() }).single("file");
	const finished = new Promise<unknown>((resolve) => {
		upload(request, response, (error) => {
			if (!error) next();
			errorHandler(error, request, response, next);
			resolve(error);
		});
	});
	stream.write(
		'--upload-boundary\r\nContent-Disposition: form-data; name="file"; filename="document.txt"\r\nContent-Type: text/plain\r\n\r\npartial content',
	);
	request.aborted = true;
	stream.destroy();
	stream.emit("aborted");
	expect(await finished).toBeInstanceOf(Error);
	expect(next).not.toHaveBeenCalled();
	expect(log).not.toHaveBeenCalled();
	expect(status).not.toHaveBeenCalled();
});
