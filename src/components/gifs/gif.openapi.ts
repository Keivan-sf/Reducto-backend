export const gifSchemas = {
	Gif: {
		type: "object",
		required: [
			"id",
			"userId",
			"objectKey",
			"fileSize",
			"width",
			"height",
			"createdAt",
			"playbackUrl",
			"thumbnailKey",
			"thumbnailUrl",
		],
		properties: {
			id: { type: "string", format: "uuid" },
			userId: { type: "string", format: "uuid" },
			objectKey: { type: "string" },
			thumbnailKey: { type: "string", nullable: true },
			thumbnailUrl: {
				type: "string",
				format: "uri",
				nullable: true,
				description:
					"First-frame JPEG of the stored MP4, valid for 15 minutes. Fetch details or the library to refresh. Null only before historical backfill. Uses the GIF dimensions.",
			},
			fileSize: { type: "integer", description: "Converted MP4 size in bytes" },
			width: {
				type: "integer",
				minimum: 1,
				nullable: true,
				description:
					"Display width in pixels; null only for historical files awaiting backfill",
			},
			height: {
				type: "integer",
				minimum: 1,
				nullable: true,
				description:
					"Display height in pixels; null only for historical files awaiting backfill",
			},
			createdAt: { type: "string", format: "date-time" },
			playbackUrl: {
				type: "string",
				format: "uri",
				description:
					"Playable presigned MP4 URL, valid for 15 minutes. Fetch GIF details or the library again to refresh.",
			},
		},
	},
};

const security = [{ bearerAuth: [] }];
const gifResponse = {
	description: "GIF with a playable MP4 URL",
	content: {
		"application/json": {
			schema: {
				type: "object",
				required: ["gif"],
				properties: { gif: { $ref: "#/components/schemas/Gif" } },
			},
		},
	},
};
const errors = {
	400: { description: "Invalid request or GIF ID" },
	401: { description: "Bearer token required" },
	404: { description: "GIF not found" },
};

export const gifPaths = {
	"/api/gifs": {
		get: {
			summary: "List my GIF library with fresh playable MP4 URLs",
			security,
			responses: {
				200: {
					description: "GIF library",
					content: {
						"application/json": {
							schema: {
								type: "object",
								required: ["gifs"],
								properties: {
									gifs: {
										type: "array",
										items: { $ref: "#/components/schemas/Gif" },
									},
								},
							},
						},
					},
				},
				...errors,
			},
		},
		post: {
			summary: "Upload a GIF or video (max 2 GB), stored as muted MP4",
			security,
			requestBody: {
				required: true,
				content: {
					"multipart/form-data": {
						schema: {
							type: "object",
							required: ["gif"],
							properties: { gif: { type: "string", format: "binary" } },
						},
					},
				},
			},
			responses: { 201: gifResponse, ...errors },
		},
	},
	"/api/gifs/{gifId}": {
		parameters: [
			{
				name: "gifId",
				in: "path",
				required: true,
				schema: { type: "string", format: "uuid" },
			},
		],
		get: {
			summary: "Get a GIF by ID with a fresh playable MP4 URL",
			security,
			responses: { 200: gifResponse, ...errors },
		},
		put: {
			summary: "Add an existing GIF to my library",
			security,
			responses: { 204: { description: "Added to library" }, ...errors },
		},
		delete: {
			summary: "Remove a GIF from my library",
			security,
			responses: { 204: { description: "Removed from library" }, ...errors },
		},
	},
};
