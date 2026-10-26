import { presenceProperties } from "../../realtime/presence.openapi.js";

export const userSchemas = {
	BasicUser: {
		type: "object",
		required: ["id", "name", "username", "avatarUrl", "online", "last_seen"],
		properties: {
			...presenceProperties,
			id: { type: "string", format: "uuid" },
			name: { type: "string", description: "User's display name" },
			username: { type: "string", nullable: true },
			avatarUrl: {
				type: "string",
				format: "uri",
				nullable: true,
				description:
					"Presigned avatar URL, valid for 15 minutes; null if no avatar",
			},
		},
	},
};

function lookup(summary: string, name: string, schema: object) {
	return {
		summary,
		tags: ["Users"],
		security: [{ bearerAuth: [] }],
		parameters: [{ name, in: "path", required: true, schema }],
		responses: {
			200: {
				description: "Basic user details",
				content: {
					"application/json": {
						schema: {
							type: "object",
							required: ["user"],
							properties: { user: { $ref: "#/components/schemas/BasicUser" } },
						},
					},
				},
			},
			400: { description: "Invalid ID or username" },
			401: { description: "Bearer access token required" },
			404: { description: "User not found" },
		},
	};
}

export const userPaths = {
	"/api/users/{userId}": {
		get: lookup("Get basic user details by ID", "userId", {
			type: "string",
			format: "uuid",
		}),
	},
	"/api/users/by-username/{username}": {
		get: lookup(
			"Get basic user details by case-insensitive username",
			"username",
			{
				type: "string",
				minLength: 1,
				maxLength: 32,
				pattern: "^[A-Za-z0-9_]+$",
			},
		),
	},
};
