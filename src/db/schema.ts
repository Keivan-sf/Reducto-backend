import { sql } from "drizzle-orm";
import {
	check,
	integer,
	doublePrecision,
	index,
	foreignKey,
	jsonb,
	pgEnum,
	pgTable,
	primaryKey,
	text,
	timestamp,
	uuid,
	unique,
} from "drizzle-orm/pg-core";

export const users = pgTable("users", {
	id: uuid("id").defaultRandom().primaryKey(),
	email: text("email").notNull().unique(),
	name: text("name").notNull(),
	username: text("username").unique(),
	avatarKey: text("avatar_key"),
	passwordHash: text("password_hash").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true })
		.defaultNow()
		.notNull(),
});

export const refreshTokens = pgTable("refresh_tokens", {
	id: uuid("id").primaryKey(),
	userId: uuid("user_id")
		.notNull()
		.references(() => users.id, { onDelete: "cascade" }),
	tokenHash: text("token_hash").notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true })
		.defaultNow()
		.notNull(),
});

export const gifs = pgTable(
	"gifs",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		objectKey: text("object_key").notNull().unique(),
		thumbnailKey: text("thumbnail_key"),
		fileSize: integer("file_size").notNull(),
		width: integer("width"),
		height: integer("height"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		check(
			"gifs_dimensions_required",
			sql`${table.width} IS NOT NULL AND ${table.height} IS NOT NULL AND ${table.width} > 0 AND ${table.height} > 0`,
		),
		check(
			"gifs_thumbnail_required",
			sql`${table.thumbnailKey} IS NOT NULL AND length(${table.thumbnailKey}) > 0`,
		),
	],
);

export const userGifs = pgTable(
	"user_gifs",
	{
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		gifId: uuid("gif_id")
			.notNull()
			.references(() => gifs.id, { onDelete: "cascade" }),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [primaryKey({ columns: [table.userId, table.gifId] })],
);

export const conversationType = pgEnum("conversation_type", [
	"private",
	"group",
]);
export const memberRole = pgEnum("member_role", ["owner", "admin", "member"]);
export const mediaType = pgEnum("media_type", [
	"image",
	"video",
	"audio",
	"music",
	"voice",
	"document",
]);
export const reactionEmoji = pgEnum("reaction_emoji", [
	"👍",
	"👎",
	"❤️",
	"😂",
	"😮",
	"😢",
	"🔥",
	"🎉",
]);

export const conversations = pgTable("conversations", {
	id: uuid("id").defaultRandom().primaryKey(),
	type: conversationType("type").notNull(),
	name: text("name"),
	privateKey: text("private_key").unique(),
	inviteToken: text("invite_token").unique(),
	createdAt: timestamp("created_at", { withTimezone: true })
		.defaultNow()
		.notNull(),
});

export const conversationMembers = pgTable(
	"conversation_members",
	{
		conversationId: uuid("conversation_id")
			.notNull()
			.references(() => conversations.id, { onDelete: "cascade" }),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		role: memberRole("role").notNull().default("member"),
		lastSeenMessageId: uuid("last_seen_message_id"),
		joinedAt: timestamp("joined_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.conversationId, table.userId] }),
		index("members_user_idx").on(table.userId),
		foreignKey({
			name: "members_last_seen_same_conversation_fk",
			columns: [table.conversationId, table.lastSeenMessageId],
			foreignColumns: [messages.conversationId, messages.id],
		}),
	],
);

export const conversationMedia = pgTable(
	"conversation_media",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		conversationId: uuid("conversation_id")
			.notNull()
			.references(() => conversations.id, { onDelete: "cascade" }),
		uploaderId: uuid("uploader_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		type: mediaType("type").notNull(),
		objectKey: text("object_key").notNull(),
		thumbnailKey: text("thumbnail_key"),
		fileName: text("file_name").notNull(),
		contentType: text("content_type").notNull(),
		fileSize: integer("file_size").notNull(),
		width: integer("width"),
		height: integer("height"),
		durationSeconds: doublePrecision("duration_seconds"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		check(
			"conversation_media_dimensions_required",
			sql`(${table.type} IN ('image', 'video') AND ${table.width} IS NOT NULL AND ${table.height} IS NOT NULL AND ${table.width} > 0 AND ${table.height} > 0) OR (${table.type} NOT IN ('image', 'video') AND ${table.width} IS NULL AND ${table.height} IS NULL)`,
		),
		check(
			"conversation_media_thumbnail_required",
			sql`(${table.type} = 'video' AND ${table.thumbnailKey} IS NOT NULL AND length(${table.thumbnailKey}) > 0) OR (${table.type} <> 'video' AND ${table.thumbnailKey} IS NULL)`,
		),
		check(
			"conversation_media_duration_required",
			sql`(${table.type} IN ('video', 'voice', 'music') AND ${table.durationSeconds} IS NOT NULL AND ${table.durationSeconds} > 0) OR (${table.type} NOT IN ('video', 'voice', 'music') AND ${table.durationSeconds} IS NULL)`,
		),
	],
);

export const messages = pgTable(
	"messages",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		conversationId: uuid("conversation_id")
			.notNull()
			.references(() => conversations.id, { onDelete: "cascade" }),
		senderId: uuid("sender_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		text: text("text"),
		replyToMessageId: uuid("reply_to_message_id"),
		attachment:
			jsonb("attachment").$type<
				import("../components/conversations/conversation.types.js").Attachment
			>(),
		forwardedFrom:
			jsonb("forwarded_from").$type<
				import("../components/conversations/conversation.types.js").ForwardOrigin
			>(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		unique("messages_conversation_id_id_unique").on(
			table.conversationId,
			table.id,
		),
		foreignKey({
			name: "messages_reply_same_conversation_fk",
			columns: [table.conversationId, table.replyToMessageId],
			foreignColumns: [table.conversationId, table.id],
		}),
		index("messages_conversation_created_idx").on(
			table.conversationId,
			table.createdAt,
			table.id,
		),
	],
);

export const messageReactions = pgTable(
	"message_reactions",
	{
		messageId: uuid("message_id")
			.notNull()
			.references(() => messages.id, { onDelete: "cascade" }),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		emoji: reactionEmoji("emoji").notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.messageId, table.userId, table.emoji] }),
	],
);
