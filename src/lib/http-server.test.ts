import { expect, test } from "@jest/globals";
import { createHttpServer } from "./http-server.js";

test("uploads have no request deadline or socket inactivity timeout", () => {
	const server = createHttpServer((_request, response) => response.end());
	expect(server.requestTimeout).toBe(0);
	expect(server.timeout).toBe(0);
	// This only limits receipt of headers, before the file starts uploading.
	expect(server.headersTimeout).toBe(60_000);
});
