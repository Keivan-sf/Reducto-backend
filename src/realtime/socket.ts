import { Server } from "socket.io";
import type { Server as HttpServer } from "node:http";
import type { AuthService } from "../components/auth/auth.service.js";
import type { Notifications } from "./notifications.js";
import { corsOptions } from "../lib/cors.js";
import { PRESENCE_INTERVAL_MS, type PresenceService } from "./presence.js";

export function userRoom(userId: string) {
	return `user:${userId}`;
}

export function attachRealtime(
	server: HttpServer,
	auth: AuthService,
	io = new Server(),
	presence?: PresenceService,
) {
	io.attach(server, { cors: corsOptions });
	io.use((socket, next) => {
		void (async () => {
			const token: unknown = socket.handshake.auth.token;
			if (typeof token !== "string")
				throw new Error("Access token is required");
			const userId = auth.verifyAccessToken(token);
			await auth.getUser(userId);
			socket.data.userId = userId;
			socket.data.expiresAt =
				JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString())
					.exp * 1000;
		})().then(
			() => next(),
			() => next(new Error("Unauthorized")),
		);
	});
	io.on("connection", (socket) => {
		void socket.join(userRoom(socket.data.userId));
		// Identity and time always come from the authenticated server connection.
		socket.on("p", () => {
			if (Date.now() < socket.data.expiresAt)
				presence?.heartbeat(socket.data.userId);
		});
		const expiry = setTimeout(
			() => socket.disconnect(true),
			Math.max(0, socket.data.expiresAt - Date.now()),
		);
		expiry.unref();
		socket.once("disconnect", () => clearTimeout(expiry));
	});
	if (presence) {
		const timer = setInterval(() => {
			void presence.tick().catch((error: unknown) => {
				console.error("Presence scan failed", error);
			});
		}, PRESENCE_INTERVAL_MS);
		timer.unref();
		server.once("close", () => clearInterval(timer));
	}
	return io;
}

export class SocketNotifications implements Notifications {
	constructor(private readonly io: Server) {}

	publish(userIds: string[], event: string, payload: unknown) {
		if (userIds.length) this.io.to(userIds.map(userRoom)).emit(event, payload);
	}
}
