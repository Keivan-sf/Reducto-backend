import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth/auth.middleware.js";
import type { AuthService } from "../auth/auth.service.js";
import {
	handle,
	validateIdParams,
} from "../conversations/conversation.router.js";
import type { ConversationService } from "../conversations/conversation.service.js";
import {
	groupSchema,
	parseInput,
	roleSchema,
	userRecipientSchema,
} from "../conversations/conversation.validation.js";

export function createGroupRouter(
	auth: AuthService,
	service: ConversationService,
) {
	const router = Router();
	router.use(requireAuth(auth));
	validateIdParams(router, ["conversationId", "userId"]);
	router.post(
		"/",
		handle(async (request, response) => {
			const input = parseInput(groupSchema, request.body);
			response.status(201).json({
				conversation: await service.createGroup(
					request.auth!.userId,
					input.name,
				),
			});
		}),
	);
	const join = handle(async (request, response) => {
		const token = parseInput(
			z.string().regex(/^[a-f0-9]{64}$/),
			request.params.token,
		);
		response.json({
			conversation: await service.joinGroup(request.auth!.userId, token),
		});
	});
	router.post("/join/:token", join);
	router.get("/join/:token", join);
	router.get(
		"/:conversationId/invite",
		handle(async (request, response) => {
			response.json(
				await service.getInvite(
					request.auth!.userId,
					String(request.params.conversationId),
				),
			);
		}),
	);
	router.patch(
		"/:conversationId",
		handle(async (request, response) => {
			const input = parseInput(groupSchema, request.body);
			await service.renameGroup(
				request.auth!.userId,
				String(request.params.conversationId),
				input.name,
			);
			response.status(204).end();
		}),
	);
	router.post(
		"/:conversationId/members",
		handle(async (request, response) => {
			const input = parseInput(userRecipientSchema, request.body);
			if ("username" in input) {
				await service.addMemberByUsername(
					request.auth!.userId,
					String(request.params.conversationId),
					input.username,
				);
			} else {
				await service.addMember(
					request.auth!.userId,
					String(request.params.conversationId),
					input.userId,
				);
			}
			response.status(204).end();
		}),
	);
	router.patch(
		"/:conversationId/members/:userId",
		handle(async (request, response) => {
			const input = parseInput(roleSchema, request.body);
			await service.setRole(
				request.auth!.userId,
				String(request.params.conversationId),
				String(request.params.userId),
				input.role,
			);
			response.status(204).end();
		}),
	);
	router.delete(
		"/:conversationId/members/:userId",
		handle(async (request, response) => {
			await service.removeMember(
				request.auth!.userId,
				String(request.params.conversationId),
				String(request.params.userId),
			);
			response.status(204).end();
		}),
	);
	router.post(
		"/:conversationId/leave",
		handle(async (request, response) => {
			await service.leaveGroup(
				request.auth!.userId,
				String(request.params.conversationId),
			);
			response.status(204).end();
		}),
	);
	router.delete(
		"/:conversationId",
		handle(async (request, response) => {
			await service.deleteGroup(
				request.auth!.userId,
				String(request.params.conversationId),
			);
			response.status(204).end();
		}),
	);
	return router;
}
