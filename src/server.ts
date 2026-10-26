import { z } from "zod";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { Server } from "socket.io";
import { createApp } from "./app.js";
import { createDatabase } from "./db/client.js";
import { DrizzleAuthRepository } from "./components/auth/auth.repository.js";
import { AuthService } from "./components/auth/auth.service.js";
import { S3ObjectStorage } from "./lib/object-storage.js";
import { DrizzleSettingsRepository } from "./components/settings/settings.repository.js";
import { SettingsService } from "./components/settings/settings.service.js";
import { DrizzleGifRepository } from "./components/gifs/gif.repository.js";
import { GifService } from "./components/gifs/gif.service.js";
import { DrizzleConversationRepository } from "./components/conversations/conversation.repository.js";
import { ConversationService } from "./components/conversations/conversation.service.js";
import { attachRealtime, SocketNotifications } from "./realtime/socket.js";
import { DrizzleUserRepository } from "./components/users/user.repository.js";
import { UserService } from "./components/users/user.service.js";
import { DrizzlePresenceRepository } from "./realtime/presence.repository.js";
import { PresenceService } from "./realtime/presence.js";

if (existsSync(".env")) process.loadEnvFile(".env");

const environment = z
	.object({
		DATABASE_URL: z.string().url(),
		ACCESS_TOKEN_SECRET: z.string().min(32),
		REFRESH_TOKEN_SECRET: z.string().min(32),
		S3_ENDPOINT: z.string().url(),
		S3_BUCKET: z.string().min(3),
		S3_ACCESS_KEY: z.string().min(3),
		S3_SECRET_KEY: z.string().min(8),
		PORT: z.coerce.number().int().positive().default(3000),
	})
	.parse(process.env);

const database = createDatabase(environment.DATABASE_URL);
const authService = new AuthService(new DrizzleAuthRepository(database), {
	accessTokenSecret: environment.ACCESS_TOKEN_SECRET,
	refreshTokenSecret: environment.REFRESH_TOKEN_SECRET,
	accessTokenLifetimeSeconds: 15 * 60,
	refreshTokenLifetimeSeconds: 30 * 24 * 60 * 60,
});
const objectStorage = new S3ObjectStorage({
	endpoint: environment.S3_ENDPOINT,
	bucket: environment.S3_BUCKET,
	accessKeyId: environment.S3_ACCESS_KEY,
	secretAccessKey: environment.S3_SECRET_KEY,
});
const io = new Server();
const notifications = new SocketNotifications(io);
const settingsService = new SettingsService(
	new DrizzleSettingsRepository(database),
	objectStorage,
	notifications,
);
const gifService = new GifService(
	new DrizzleGifRepository(database),
	objectStorage,
);

const conversationService = new ConversationService(
	new DrizzleConversationRepository(database),
	objectStorage,
	notifications,
);
const server = createServer(
	createApp(
		authService,
		settingsService,
		gifService,
		conversationService,
		new UserService(new DrizzleUserRepository(database), objectStorage),
	),
);
attachRealtime(
	server,
	authService,
	io,
	new PresenceService(new DrizzlePresenceRepository(database), notifications),
);
server.listen(environment.PORT, () =>
	console.log(`Reducto API listening on port ${environment.PORT}`),
);
