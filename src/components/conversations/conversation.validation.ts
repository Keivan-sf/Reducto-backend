import { z } from "zod";
import { HttpError } from "../../lib/http.js";
import { REACTION_EMOJIS } from "./conversation.types.js";

const fileAttachment = z
	.object({
		type: z.enum(["image", "video", "audio", "music", "document"]),
		mediaId: z.uuid().toLowerCase(),
	})
	.strict();
const gifAttachment = z
	.object({ type: z.literal("gif"), gifId: z.uuid().toLowerCase() })
	.strict();
export const messageSchema = z
	.object({
		text: z.string().trim().min(1).max(10000).optional(),
		attachment: z.union([fileAttachment, gifAttachment]).optional(),
	})
	.strict()
	.refine(
		(value) => value.text !== undefined || value.attachment !== undefined,
		"A message needs text or one attachment",
	);
export const groupSchema = z
	.object({ name: z.string().trim().min(1).max(100) })
	.strict();
export const userSchema = z.object({ userId: z.uuid().toLowerCase() }).strict();
export const usernameSchema = z
	.string()
	.min(1)
	.max(32)
	.regex(/^[A-Za-z0-9_]+$/)
	.toLowerCase();
export const privateRecipientSchema = z.union([
	userSchema,
	z.object({ username: usernameSchema }).strict(),
]);
export const roleSchema = z
	.object({ role: z.enum(["admin", "member"]) })
	.strict();
export const forwardSchema = z
	.object({ messageId: z.uuid().toLowerCase() })
	.strict();
export const reactionSchema = z
	.object({ emoji: z.enum(REACTION_EMOJIS) })
	.strict();
export const pageSchema = z
	.object({
		limit: z.coerce.number().int().min(1).max(100).default(50),
		before: z.uuid().toLowerCase().optional(),
	})
	.strict();

export function parseInput<Output>(
	schema: z.ZodType<Output>,
	input: unknown,
): Output {
	const parsed = schema.safeParse(input);
	if (!parsed.success)
		throw new HttpError(
			400,
			"Invalid request: " +
				parsed.error.issues.map((issue) => issue.message).join(", "),
		);
	return parsed.data;
}
