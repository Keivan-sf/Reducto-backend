export const adminPaths = {
	"/api/admin/cleanup": {
		post: {
			summary:
				"Delete all messages and non-GIF attachments and their stored files",
			description:
				"Preserves GIFs and their libraries, accounts, avatars, conversations and memberships. Resets message read markers. Broadcasts messages.cleared to all connected clients after success. Authenticate only with the ADMIN_PASSWORD value in the JSON body; no bearer token is required.",
			security: [],
			requestBody: {
				required: true,
				content: {
					"application/json": {
						schema: {
							type: "object",
							required: ["password"],
							properties: {
								password: { type: "string", minLength: 1, writeOnly: true },
							},
						},
					},
				},
			},
			responses: {
				"200": {
					description:
						"Cleanup committed; socket event carries the same payload",
					content: {
						"application/json": {
							schema: {
								type: "object",
								required: [
									"deletedMessages",
									"deletedAttachments",
									"completedAt",
								],
								properties: {
									deletedMessages: { type: "integer" },
									deletedAttachments: { type: "integer" },
									completedAt: { type: "string", format: "date-time" },
								},
							},
						},
					},
				},
				"400": { description: "Invalid request body" },
				"401": { description: "Incorrect admin password" },
				"409": { description: "Cleanup already running in this process" },
				"502": { description: "S3 deletion failed; retry cleanup" },
				"503": { description: "ADMIN_PASSWORD is not configured" },
			},
		},
	},
};
