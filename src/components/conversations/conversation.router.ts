import {
	Router,
	type Request,
	type Response,
	type NextFunction,
} from "express";
import multer from "multer";
import { z } from "zod";
import { requireAuth } from "../auth/auth.middleware.js";
import type { AuthService } from "../auth/auth.service.js";
import {
	MAX_ATTACHMENT_SIZE_BYTES,
	type ConversationService,
} from "./conversation.service.js";
import {
	forwardSchema,
	messageSchema,
	pageSchema,
	parseInput,
	reactionSchema,
	privateRecipientSchema,
	usernameSchema,
} from "./conversation.validation.js";

export function handle(
	action: (request: Request, response: Response) => Promise<unknown>,
) {
	return (request: Request, response: Response, next: NextFunction) => {
		void action(request, response).catch(next);
	};
}

export function validateIdParams(router: Router, names: string[]) {
	for (const name of names) {
		router.param(name, (request, _response, next, value: string) => {
			try {
				request.params[name] = parseInput(z.uuid().toLowerCase(), value);
				next();
			} catch (error) {
				next(error);
			}
		});
	}
}

export function createConversationRouter(
	auth: AuthService,
	service: ConversationService,
) {
	const router = Router();
	router.use(requireAuth(auth));
	validateIdParams(router, [
		"conversationId",
		"userId",
		"messageId",
		"mediaId",
	]);
	const upload = multer({
		storage: multer.memoryStorage(),
		limits: { fileSize: MAX_ATTACHMENT_SIZE_BYTES, files: 1, fields: 1 },
	});
	router.get(
		"/",
		handle(async (request, response) => {
			response.json({
				conversations: await service.listConversations(request.auth!.userId),
			});
		}),
	);
	router.post(
		"/private",
		handle(async (request, response) => {
			const input = parseInput(privateRecipientSchema, request.body);
			response.status(200).json({
				conversation:
					"username" in input
						? await service.createPrivateByUsername(
								request.auth!.userId,
								input.username,
							)
						: await service.createPrivate(request.auth!.userId, input.userId),
			});
		}),
	);
	router.post(
		"/private/by-username/:username/messages",
		handle(async (request, response) => {
			const username = parseInput(usernameSchema, request.params.username);
			const input = parseInput(messageSchema, request.body);
			response.status(201).json({
				message: await service.sendPrivateByUsername(
					request.auth!.userId,
					username,
					input,
				),
			});
		}),
	);
	router.post(
		"/private/:userId/messages",
		handle(async (request, response) => {
			const input = parseInput(messageSchema, request.body);
			response.status(201).json({
				message: await service.sendPrivate(
					request.auth!.userId,
					String(request.params.userId),
					input,
				),
			});
		}),
	);
	router.get(
		"/:conversationId",
		handle(async (request, response) => {
			response.json({
				conversation: await service.getConversation(
					request.auth!.userId,
					String(request.params.conversationId),
				),
			});
		}),
	);
	router.get(
		"/:conversationId/members",
		handle(async (request, response) => {
			response.json({
				members: await service.listMembers(
					request.auth!.userId,
					String(request.params.conversationId),
				),
			});
		}),
	);
	router.get(
		"/:conversationId/messages",
		handle(async (request, response) => {
			const page = parseInput(pageSchema, request.query);
			response.json(
				await service.listMessages(
					request.auth!.userId,
					String(request.params.conversationId),
					page.limit,
					page.before,
				),
			);
		}),
	);
	router.post(
		"/:conversationId/messages",
		handle(async (request, response) => {
			const input = parseInput(messageSchema, request.body);
			response.status(201).json({
				message: await service.sendMessage(
					request.auth!.userId,
					String(request.params.conversationId),
					input,
				),
			});
		}),
	);
	router.post(
		"/:conversationId/forward",
		handle(async (request, response) => {
			const input = parseInput(forwardSchema, request.body);
			response.status(201).json({
				message: await service.forwardMessage(
					request.auth!.userId,
					String(request.params.conversationId),
					input.messageId,
				),
			});
		}),
	);
	router.put(
		"/:conversationId/messages/:messageId/reactions",
		handle(async (request, response) => {
			const input = parseInput(reactionSchema, request.body);
			await service.react(
				request.auth!.userId,
				String(request.params.conversationId),
				String(request.params.messageId),
				input.emoji,
			);
			response.status(204).end();
		}),
	);
	router.delete(
		"/:conversationId/messages/:messageId/reactions",
		handle(async (request, response) => {
			const input = parseInput(reactionSchema, request.body);
			await service.react(
				request.auth!.userId,
				String(request.params.conversationId),
				String(request.params.messageId),
				input.emoji,
				true,
			);
			response.status(204).end();
		}),
	);
	router.post(
		"/:conversationId/attachments",
		(request, _response, next) => {
			void service
				.requireMember(
					request.auth!.userId,
					String(request.params.conversationId),
				)
				.then(() => next(), next);
		},
		upload.single("file"),
		handle(async (request, response) => {
			if (!request.file) {
				response.status(400).json({ error: "Attachment file is required" });
				return;
			}
			const input = parseInput(
				z.object({ kind: z.literal("music").optional() }).strict(),
				request.body,
			);
			const attachment = await service.uploadAttachment(
				request.auth!.userId,
				String(request.params.conversationId),
				request.file,
				input.kind,
			);
			response.status(201).json({ attachment });
		}),
	);
	router.get(
		"/:conversationId/attachments/:mediaId",
		handle(async (request, response) => {
			const { media, body } = await service.downloadAttachment(
				request.auth!.userId,
				String(request.params.conversationId),
				String(request.params.mediaId),
			);
			response.setHeader("X-Content-Type-Options", "nosniff");
			response.attachment(media.fileName);
			response.setHeader("Content-Type", "application/octet-stream");
			response.send(body);
		}),
	);
	return router;
}
