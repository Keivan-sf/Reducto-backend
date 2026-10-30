import { REACTION_EMOJIS } from "./conversation.types.js";
import { presenceProperties } from "../../realtime/presence.openapi.js";

const uuid = { type: "string", format: "uuid" };
const reference = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const body = (schema: object) => ({
	required: true,
	content: { "application/json": { schema } },
});
const object = (
	properties: Record<string, object>,
	required = Object.keys(properties),
) => ({ type: "object", properties, required, additionalProperties: false });
const parameter = (name: string) => ({
	name,
	in: "path",
	required: true,
	schema:
		name === "token" ? { type: "string", pattern: "^[a-f0-9]{64}$" } : uuid,
});
const operation = (
	summary: string,
	success: number,
	schema?: object,
	parameters: object[] = [],
	result?: object,
) => ({
	summary,
	tags: ["Conversations and groups"],
	security: [{ bearerAuth: [] }],
	parameters,
	...(schema ? { requestBody: body(schema) } : {}),
	responses: {
		[success]: {
			description: "Success",
			...(result
				? { content: { "application/json": { schema: result } } }
				: {}),
		},
		400: { description: "Invalid request" },
		401: { description: "Bearer access token required" },
		403: { description: "Membership or role does not permit this operation" },
		404: { description: "Resource not found" },
	},
});

export const chatSchemas = {
	Media: object({
		id: uuid,
		conversationId: uuid,
		uploaderId: uuid,
		type: {
			type: "string",
			enum: ["image", "video", "audio", "music", "voice", "document"],
		},
		objectKey: { type: "string" },
		thumbnailKey: { type: "string", nullable: true },
		thumbnailUrl: {
			type: "string",
			format: "uri",
			nullable: true,
			description:
				"First-frame JPEG URL, valid for 15 minutes. Refresh metadata to renew. Null for nonvideo attachments or historical videos awaiting backfill. Uses the video dimensions.",
		},
		fileName: { type: "string" },
		title: {
			type: "string",
			nullable: true,
			description: "Embedded music title; null when absent or not music.",
		},
		artist: {
			type: "string",
			nullable: true,
			description: "Embedded music artist; null when absent or not music.",
		},
		coverKey: {
			type: "string",
			nullable: true,
			description:
				"Object key of the extracted JPEG music cover; null when absent.",
		},
		coverUrl: {
			type: "string",
			format: "uri",
			nullable: true,
			description:
				"Signed music cover URL, valid for 15 minutes. Refresh attachment metadata to renew; null when absent.",
		},
		contentType: { type: "string" },
		fileSize: {
			type: "integer",
			description:
				"Stored attachment size in bytes for every media type, including documents. For voice messages, this is the converted Ogg file size.",
		},
		durationSeconds: {
			type: "number",
			format: "double",
			minimum: 0,
			nullable: true,
			description:
				"Positive duration in seconds for voice messages, music, and videos; null for other media.",
		},
		width: {
			type: "integer",
			minimum: 1,
			nullable: true,
			description:
				"Display width in pixels; null for nonvisual files or historical files awaiting backfill",
		},
		height: {
			type: "integer",
			minimum: 1,
			nullable: true,
			description:
				"Display height in pixels; null for nonvisual files or historical files awaiting backfill",
		},
		createdAt: { type: "string", format: "date-time" },
	}),
	MessageAttachment: {
		oneOf: [
			object({ type: { type: "string", enum: ["gif"] }, gifId: uuid }),
			object({
				type: {
					type: "string",
					enum: ["image", "video", "audio", "music", "voice", "document"],
				},
				mediaId: uuid,
			}),
		],
	},
	SendMessage: {
		description:
			"New group messages (including forwards and attachment captions) record case-insensitive @username mentions for current members, once per user per message. Email addresses and overlong tokens are ignored. Edits do not change mentions; private messages never create them.",
		...object(
			{
				text: { type: "string", minLength: 1, maxLength: 10000 },
				attachment: reference("MessageAttachment"),
				replyToMessageId: {
					...uuid,
					description:
						"Optional ID of an existing message in this conversation",
				},
			},
			[],
		),
		anyOf: [{ required: ["text"] }, { required: ["attachment"] }],
	},
	Mention: object({
		userId: uuid,
		conversationId: uuid,
		messageId: uuid,
		seen: { type: "boolean" },
	}),
	Conversation: object(
		{
			id: uuid,
			type: {
				type: "string",
				enum: ["private", "group", "saved"],
				description:
					"Saved Messages is created automatically, has only its owner as a member, and cannot be modified or deleted.",
			},
			name: { type: "string", nullable: true },
			createdAt: { type: "string", format: "date-time" },
			lastSeenMessageId: {
				...uuid,
				nullable: true,
				description: "Included when retrieving a group conversation.",
			},
			unseenMentions: {
				type: "array",
				items: reference("Mention"),
				description:
					"Included when retrieving a group conversation; only the authenticated user's unseen mentions.",
			},
		},
		["id", "type", "name", "createdAt"],
	),
	ReadState: object({
		lastSeenMessageId: { ...uuid, nullable: true },
		unreadCount: {
			type: "integer",
			minimum: 0,
			description:
				"Messages newer than the seen position, including your own; all messages if never seen",
		},
	}),
	ConversationListItem: object(
		{
			id: uuid,
			type: {
				type: "string",
				enum: ["private", "group", "saved"],
				description:
					"Saved Messages is created automatically, has only its owner as a member, and cannot be modified or deleted.",
			},
			name: { type: "string", nullable: true },
			createdAt: { type: "string", format: "date-time" },
			lastSeenMessageId: { ...uuid, nullable: true },
			unreadCount: { type: "integer", minimum: 0 },
			unseenMentions: {
				type: "array",
				items: reference("Mention"),
				description:
					"Group conversations only; the authenticated user's unseen mentions.",
			},
		},
		["id", "type", "name", "createdAt", "lastSeenMessageId", "unreadCount"],
	),
	Member: object({
		...presenceProperties,
		conversationId: uuid,
		userId: uuid,
		role: { type: "string", enum: ["owner", "admin", "member"] },
		joinedAt: { type: "string", format: "date-time" },
		lastSeenMessageId: { ...uuid, nullable: true },
	}),

	Message: object({
		id: uuid,
		conversationId: uuid,
		senderId: uuid,
		text: { type: "string", nullable: true },
		isEdited: {
			type: "boolean",
			default: false,
			description: "True after the message text has been edited.",
		},
		replyToMessageId: { ...uuid, nullable: true },
		attachment: { ...reference("MessageAttachment"), nullable: true },
		attachmentMetadata: {
			oneOf: [reference("Media"), reference("Gif")],
			nullable: true,
			description:
				"Full media or GIF metadata for the attachment, including fileSize in bytes and fresh signed preview URLs. Null when there is no attachment or its record is unavailable.",
		},
		forwardedFrom: {
			...object({ messageId: uuid, conversationId: uuid, senderId: uuid }),
			nullable: true,
		},
		createdAt: { type: "string", format: "date-time" },
	}),
	Reaction: object({ emoji: { type: "string", enum: [...REACTION_EMOJIS] } }),
};

const conversationParams = [parameter("conversationId")];
const messageParams = [...conversationParams, parameter("messageId")];
const memberParams = [...conversationParams, parameter("userId")];
const nameBody = object({
	name: { type: "string", minLength: 1, maxLength: 100 },
});
const userBody = object({ userId: uuid });
const username = {
	type: "string",
	minLength: 1,
	maxLength: 32,
	pattern: "^[A-Za-z0-9_]+$",
	description: "Case-insensitive username",
};
const userRecipientBody = { oneOf: [userBody, object({ username })] };
const messageResult = object({ message: reference("Message") });
const conversationResult = object({ conversation: reference("Conversation") });

const searchParameters = [
	{
		name: "q",
		in: "query",
		required: true,
		schema: { type: "string", minLength: 1, maxLength: 1000 },
		description:
			"Trimmed, case-insensitive literal substring in message text, attachment filename, music title, or artist.",
	},
	{
		name: "limit",
		in: "query",
		schema: { type: "integer", minimum: 1, maximum: 100, default: 50 },
	},
	{
		name: "before",
		in: "query",
		schema: uuid,
		description:
			"Message cursor from nextCursor; use the same query and scope for subsequent pages.",
	},
];
const searchResult = object({
	messages: { type: "array", items: reference("Message") },
	nextCursor: { ...uuid, nullable: true },
});

export const chatPaths = {
	"/api/conversations/search": {
		get: operation(
			"Search messages in all conversations I currently belong to, newest first",
			200,
			undefined,
			searchParameters,
			searchResult,
		),
	},
	"/api/conversations/{conversationId}/messages/search": {
		get: operation(
			"Search messages in a conversation I belong to, newest first",
			200,
			undefined,
			[...conversationParams, ...searchParameters],
			searchResult,
		),
	},
	"/api/conversations/{conversationId}/messages/first": {
		get: operation(
			"Get the oldest message, including reactions; null for an empty conversation",
			200,
			undefined,
			conversationParams,
			object({
				message: {
					...chatSchemas.Message,
					nullable: true,
					properties: {
						...chatSchemas.Message.properties,
						reactions: {
							type: "array",
							items: object({
								messageId: uuid,
								userId: uuid,
								emoji: { type: "string", enum: [...REACTION_EMOJIS] },
							}),
						},
					},
					required: [...chatSchemas.Message.required, "reactions"],
				},
			}),
		),
	},
	"/api/conversations/{conversationId}/messages/{messageId}/around": {
		get: operation(
			"Get the target message and its nearest older/newer messages",
			200,
			undefined,
			[
				...messageParams,
				{
					name: "before",
					in: "query",
					schema: { type: "integer", minimum: 0, maximum: 100, default: 50 },
				},
				{
					name: "after",
					in: "query",
					schema: { type: "integer", minimum: 0, maximum: 100, default: 50 },
				},
			],
			object({
				message: reference("Message"),
				before: {
					type: "array",
					items: reference("Message"),
					description: "Nearest older messages, oldest first",
				},
				after: {
					type: "array",
					items: reference("Message"),
					description: "Nearest newer messages, oldest first",
				},
				hasMoreBefore: { type: "boolean" },
				hasMoreAfter: { type: "boolean" },
			}),
		),
	},
	"/api/conversations/{conversationId}/messages/{messageId}": {
		patch: operation(
			"Edit only the text of your own message; notifies all current conversation members via message.updated",
			200,
			object({ text: { type: "string", minLength: 1, maxLength: 10000 } }),
			messageParams,
			messageResult,
		),
		get: operation(
			"Get a message, including a reply target outside the current history page",
			200,
			undefined,
			messageParams,
			messageResult,
		),
	},
	"/api/conversations": {
		get: operation(
			"List my conversations (private conversations appear only after a message is sent)",
			200,
			undefined,
			[],
			object({
				conversations: {
					type: "array",
					items: reference("ConversationListItem"),
				},
			}),
		),
	},
	"/api/conversations/private": {
		post: operation(
			"Create or reuse the unique private conversation by user ID or username, without notifications; hidden from lists until a message is sent",
			200,
			userRecipientBody,
			[],
			conversationResult,
		),
	},
	"/api/conversations/private/{userId}/messages": {
		post: operation(
			"Send a private message, creating the conversation if needed",
			201,
			reference("SendMessage"),
			[parameter("userId")],
			messageResult,
		),
	},
	"/api/conversations/private/by-username/{username}/messages": {
		post: operation(
			"Send a private message by case-insensitive username, creating the chat if needed",
			201,
			reference("SendMessage"),
			[{ name: "username", in: "path", required: true, schema: username }],
			messageResult,
		),
	},
	"/api/conversations/{conversationId}": {
		get: operation(
			"Get a conversation I belong to",
			200,
			undefined,
			conversationParams,
			conversationResult,
		),
	},
	"/api/conversations/{conversationId}/seen": {
		put: operation(
			"Advance my seen position; repeated or older messages are ignored",
			200,
			object({ messageId: uuid }),
			conversationParams,
			reference("ReadState"),
		),
	},
	"/api/conversations/{conversationId}/mentions/{messageId}/seen": {
		put: operation(
			"Mark my group mention seen (idempotent). Only the mentioned current member can do this; missing or another user's mention returns 404. Does not advance the conversation seen position.",
			200,
			undefined,
			messageParams,
			object({ mention: reference("Mention") }),
		),
	},

	"/api/conversations/{conversationId}/members": {
		get: operation(
			"List members and their last-seen message IDs",
			200,
			undefined,
			conversationParams,
			object({ members: { type: "array", items: reference("Member") } }),
		),
	},
	"/api/conversations/{conversationId}/messages": {
		get: operation("Read message history, newest first", 200, undefined, [
			...conversationParams,
			{
				name: "limit",
				in: "query",
				schema: { type: "integer", minimum: 1, maximum: 100, default: 50 },
			},
			{ name: "before", in: "query", schema: uuid },
		]),
		post: operation(
			"Send text and/or one attachment",
			201,
			reference("SendMessage"),
			conversationParams,
			messageResult,
		),
	},
	"/api/conversations/{conversationId}/forward": {
		post: operation(
			"Forward an accessible message into this conversation",
			201,
			object({ messageId: uuid }),
			conversationParams,
			messageResult,
		),
	},
	"/api/conversations/{conversationId}/messages/{messageId}/reactions": {
		put: operation(
			"Add a predefined emoji reaction",
			204,
			reference("Reaction"),
			messageParams,
		),
		delete: operation(
			"Remove my emoji reaction",
			204,
			reference("Reaction"),
			messageParams,
		),
	},
	"/api/conversations/{conversationId}/attachments": {
		post: {
			...operation(
				"Upload one attachment (max 2 GB); animated GIF messages use /api/gifs",
				201,
				undefined,
				conversationParams,
				object({ attachment: reference("Media") }),
			),
			requestBody: {
				required: true,
				content: {
					"multipart/form-data": {
						schema: object(
							{
								file: { type: "string", format: "binary" },
								kind: {
									type: "string",
									enum: ["music", "voice", "document"],
									description:
										"Use document to send any file (including images, videos, audio, and GIFs) as a document, preserving its original bytes, filename, and MIME type without media processing. Omit kind for automatic classification. Use voice for speech uploads: audio is converted to mono Ogg Opus at a target bitrate of 30 kbit/s. Music and ordinary audio preserve the original file.",
								},
							},
							["file"],
						),
					},
				},
			},
		},
	},
	"/api/conversations/{conversationId}/attachments/{mediaId}/metadata": {
		get: operation(
			"Get attachment metadata without downloading the file",
			200,
			undefined,
			[...conversationParams, parameter("mediaId")],
			object({ attachment: reference("Media") }),
		),
	},
	"/api/conversations/{conversationId}/attachments/{mediaId}": {
		get: operation("Download a conversation attachment", 200, undefined, [
			...conversationParams,
			parameter("mediaId"),
		]),
	},
	"/api/groups": {
		post: operation(
			"Create a group and its unique invite link",
			201,
			nameBody,
			[],
			conversationResult,
		),
	},
	"/api/groups/join/{token}": {
		get: operation(
			"Follow an invite and join the group (authenticated)",
			200,
			undefined,
			[parameter("token")],
			conversationResult,
		),
		post: operation(
			"Join a group using an invite",
			200,
			undefined,
			[parameter("token")],
			conversationResult,
		),
	},
	"/api/groups/{conversationId}": {
		patch: operation(
			"Owner/admin: rename a group",
			204,
			nameBody,
			conversationParams,
		),
		delete: operation(
			"Owner only: delete a group",
			204,
			undefined,
			conversationParams,
		),
	},
	"/api/groups/{conversationId}/invite": {
		get: operation(
			"Owner/admin: retrieve the group's invite link",
			200,
			undefined,
			conversationParams,
		),
	},
	"/api/groups/{conversationId}/members": {
		post: operation(
			"Owner/admin: add a member by user ID or case-insensitive username",
			204,
			userRecipientBody,
			conversationParams,
		),
	},
	"/api/groups/{conversationId}/members/{userId}": {
		patch: operation(
			"Owner only: promote or demote an admin",
			204,
			object({ role: { type: "string", enum: ["admin", "member"] } }),
			memberParams,
		),
		delete: operation(
			"Owner/admin: remove a member other than the owner",
			204,
			undefined,
			memberParams,
		),
	},
	"/api/groups/{conversationId}/leave": {
		post: operation(
			"Leave a group (owner must delete instead)",
			204,
			undefined,
			conversationParams,
		),
	},
};
