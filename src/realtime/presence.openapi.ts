export const presenceProperties = {
	online: {
		type: "boolean",
		description:
			"Whether the server received a heartbeat within the last 60 seconds.",
	},
	last_seen: {
		type: "string",
		format: "date-time",
		nullable: true,
		description:
			"Latest heartbeat receipt time; null if no heartbeat is known.",
	},
};
