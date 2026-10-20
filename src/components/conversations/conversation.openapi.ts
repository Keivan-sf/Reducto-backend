import { REACTION_EMOJIS } from "./conversation.types.js";

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
			enum: ["image", "video", "audio", "music", "document"],
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
		contentType: { type: "string" },
		fileSize: { type: "integer" },
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
					enum: ["image", "video", "audio", "music", "document"],
				},
				mediaId: uuid,
			}),
		],
	},
	SendMessage: {
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
	Conversation: object({
		id: uuid,
		type: { type: "string", enum: ["private", "group"] },
		name: { type: "string", nullable: true },
		createdAt: { type: "string", format: "date-time" },
	}),
	Message: object({
		id: uuid,
		conversationId: uuid,
		senderId: uuid,
		text: { type: "string", nullable: true },
		replyToMessageId: { ...uuid, nullable: true },
		attachment: { ...reference("MessageAttachment"), nullable: true },
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
const privateRecipientBody = { oneOf: [userBody, object({ username })] };
const messageResult = object({ message: reference("Message") });
const conversationResult = object({ conversation: reference("Conversation") });

export const chatPaths = {
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
			"List my conversations",
			200,
			undefined,
			[],
			object({
				conversations: { type: "array", items: reference("Conversation") },
			}),
		),
	},
	"/api/conversations/private": {
		post: operation(
			"Create or reuse a private conversation by user ID or username",
			200,
			privateRecipientBody,
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
	"/api/conversations/{conversationId}/members": {
		get: operation("List members", 200, undefined, conversationParams),
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
				"Upload one attachment (max 50 MB); GIFs use /api/gifs",
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
								kind: { type: "string", enum: ["music"] },
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
			"Owner/admin: add a member",
			204,
			userBody,
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
