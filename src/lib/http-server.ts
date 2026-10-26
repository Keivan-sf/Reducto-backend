import { createServer, type RequestListener } from "node:http";

export function createHttpServer(listener: RequestListener) {
	// Node defaults to a five-minute deadline for receiving the entire upload.
	// Limit header receipt separately, without limiting upload duration.
	const server = createServer(
		{ requestTimeout: 0, headersTimeout: 60_000 },
		listener,
	);
	server.setTimeout(0);
	return server;
}
