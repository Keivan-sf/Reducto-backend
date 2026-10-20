import {
	FfmpegThumbnailGenerator,
	type ThumbnailGenerator,
} from "../../lib/video-thumbnail.js";
import {
	MediaDimensionReader,
	type DimensionReader,
} from "../../lib/media-dimensions.js";
import { randomBytes, randomUUID } from "node:crypto";
import { HttpError } from "../../lib/http.js";
import type { ObjectStorage } from "../../lib/object-storage.js";
import type { Notifications } from "../../realtime/notifications.js";
import type { ConversationRepository } from "./conversation.repository.js";
import type {
	Conversation,
	Media,
	MediaType,
	Message,
	MessagePage,
	NewMessage,
	ReactionEmoji,
} from "./conversation.types.js";
import {
	groupSchema,
	messageSchema,
	parseInput,
	reactionSchema,
	usernameSchema,
	aroundMessagesSchema,
} from "./conversation.validation.js";

export const MAX_ATTACHMENT_SIZE_BYTES = 50 * 1024 * 1024;
export interface ChatObjectStorage extends ObjectStorage {
	getObject(key: string): Promise<Buffer>;
	getThumbnailUrl(key: string): Promise<string>;
}

export class ConversationService {
	constructor(
		private readonly repository: ConversationRepository,
		private readonly storage: ChatObjectStorage,
		private readonly notifications: Notifications,
		private readonly dimensions: DimensionReader = new MediaDimensionReader(),
		private readonly thumbnails: ThumbnailGenerator = new FfmpegThumbnailGenerator(),
	) {}

	private publicConversation(conversation: Conversation) {
		return {
			id: conversation.id,
			type: conversation.type,
			name: conversation.name,
			createdAt: conversation.createdAt,
		};
	}

	async requireMember(userId: string, conversationId: string) {
		const member = await this.repository.getMember(conversationId, userId);
		if (!member)
			throw new HttpError(403, "Conversation membership is required");
		return member;
	}

	private async requireGroupManager(userId: string, conversationId: string) {
		const member = await this.requireMember(userId, conversationId);
		const conversation = await this.repository.getConversation(conversationId);
		if (!conversation || conversation.type !== "group")
			throw new HttpError(400, "This operation requires a group");
		if (member.role === "member")
			throw new HttpError(403, "Group owner or admin is required");
		return { conversation, member };
	}

	private async publish(
		conversationId: string,
		event: string,
		payload: unknown,
		extraUsers: string[] = [],
	) {
		const members = await this.repository.listMembers(conversationId);
		this.notifications.publish(
			[...new Set([...members.map((member) => member.userId), ...extraUsers])],
			event,
			payload,
		);
	}

	async listConversations(userId: string) {
		return (await this.repository.listConversations(userId)).map(
			(conversation) => this.publicConversation(conversation),
		);
	}

	async getConversation(userId: string, conversationId: string) {
		await this.requireMember(userId, conversationId);
		const conversation = await this.repository.getConversation(conversationId);
		if (!conversation) throw new HttpError(404, "Conversation not found");
		return this.publicConversation(conversation);
	}

	async listMembers(userId: string, conversationId: string) {
		await this.requireMember(userId, conversationId);
		return this.repository.listMembers(conversationId);
	}

	async createPrivate(userId: string, recipientId: string) {
		recipientId = recipientId.toLowerCase();
		if (userId === recipientId) throw new HttpError(400, "Choose another user");
		if (
			!(await this.repository.userExists(userId)) ||
			!(await this.repository.userExists(recipientId))
		)
			throw new HttpError(404, "User not found");
		return this.publicConversation(
			await this.repository.createPrivate([userId, recipientId]),
		);
	}

	async sendPrivate(userId: string, recipientId: string, input: NewMessage) {
		parseInput(messageSchema, input);
		const conversation = await this.createPrivate(userId, recipientId);
		return this.sendMessage(userId, conversation.id, input);
	}

	private async resolveUsername(username: string) {
		const normalized = parseInput(usernameSchema, username);
		const recipientId = await this.repository.findUserIdByUsername(normalized);
		if (!recipientId) throw new HttpError(404, "User not found");
		return recipientId;
	}

	async createPrivateByUsername(userId: string, username: string) {
		return this.createPrivate(userId, await this.resolveUsername(username));
	}

	async sendPrivateByUsername(
		userId: string,
		username: string,
		input: NewMessage,
	) {
		parseInput(messageSchema, input);
		return this.sendPrivate(
			userId,
			await this.resolveUsername(username),
			input,
		);
	}

	async createGroup(userId: string, name: string) {
		const input = parseInput(groupSchema, { name });
		if (!(await this.repository.userExists(userId)))
			throw new HttpError(404, "User not found");
		const conversation = await this.repository.createGroup(
			userId,
			input.name,
			randomBytes(32).toString("hex"),
		);
		return {
			...this.publicConversation(conversation),
			inviteLink: `/api/groups/join/${conversation.inviteToken}`,
		};
	}

	async getInvite(userId: string, conversationId: string) {
		const { conversation } = await this.requireGroupManager(
			userId,
			conversationId,
		);
		return { inviteLink: `/api/groups/join/${conversation.inviteToken}` };
	}

	async joinGroup(userId: string, token: string) {
		const conversation = await this.repository.findByInvite(token);
		if (!conversation || conversation.type !== "group")
			throw new HttpError(404, "Invalid group invite");
		if (!(await this.repository.userExists(userId)))
			throw new HttpError(404, "User not found");
		if (!(await this.repository.getMember(conversation.id, userId))) {
			await this.repository.addMember(conversation.id, userId);
			await this.publish(conversation.id, "group.member_joined", {
				conversationId: conversation.id,
				userId,
			});
		}
		return this.publicConversation(conversation);
	}

	async renameGroup(userId: string, conversationId: string, name: string) {
		const input = parseInput(groupSchema, { name });
		await this.requireGroupManager(userId, conversationId);
		await this.repository.renameGroup(conversationId, input.name);
		await this.publish(conversationId, "conversation.updated", {
			conversationId,
			name: input.name,
		});
	}

	async addMember(userId: string, conversationId: string, targetId: string) {
		await this.requireGroupManager(userId, conversationId);
		if (!(await this.repository.userExists(targetId)))
			throw new HttpError(404, "User not found");
		if (!(await this.repository.getMember(conversationId, targetId))) {
			await this.repository.addMember(conversationId, targetId);
			await this.publish(conversationId, "group.member_joined", {
				conversationId,
				userId: targetId,
			});
		}
	}

	async setRole(
		userId: string,
		conversationId: string,
		targetId: string,
		role: "admin" | "member",
	) {
		const { member } = await this.requireGroupManager(userId, conversationId);
		if (member.role !== "owner")
			throw new HttpError(403, "Only the owner can change admin roles");
		const target = await this.repository.getMember(conversationId, targetId);
		if (!target) throw new HttpError(404, "Member not found");
		if (target.role === "owner")
			throw new HttpError(400, "Cannot change the owner's role");
		await this.repository.setRole(conversationId, targetId, role);
		await this.publish(conversationId, "group.role_changed", {
			conversationId,
			userId: targetId,
			role,
		});
	}

	async removeMember(userId: string, conversationId: string, targetId: string) {
		await this.requireGroupManager(userId, conversationId);
		const target = await this.repository.getMember(conversationId, targetId);
		if (!target) throw new HttpError(404, "Member not found");
		if (target.role === "owner")
			throw new HttpError(403, "Cannot remove the owner");
		await this.repository.removeMember(conversationId, targetId);
		await this.publish(
			conversationId,
			"group.member_left",
			{ conversationId, userId: targetId },
			[targetId],
		);
	}

	async leaveGroup(userId: string, conversationId: string) {
		const member = await this.requireMember(userId, conversationId);
		const conversation = await this.repository.getConversation(conversationId);
		if (conversation?.type !== "group")
			throw new HttpError(400, "Cannot leave a private conversation");
		if (member.role === "owner")
			throw new HttpError(
				400,
				"The owner must delete the group instead of leaving",
			);
		await this.repository.removeMember(conversationId, userId);
		await this.publish(
			conversationId,
			"group.member_left",
			{ conversationId, userId },
			[userId],
		);
	}

	async deleteGroup(userId: string, conversationId: string) {
		const { member } = await this.requireGroupManager(userId, conversationId);
		if (member.role !== "owner")
			throw new HttpError(403, "Only the owner can delete a group");
		const members = await this.repository.listMembers(conversationId);
		await this.repository.deleteGroup(conversationId);
		this.notifications.publish(
			members.map((entry) => entry.userId),
			"conversation.deleted",
			{ conversationId },
		);
	}

	async sendMessage(userId: string, conversationId: string, input: NewMessage) {
		const parsed = parseInput(messageSchema, input);
		await this.requireMember(userId, conversationId);
		if (parsed.replyToMessageId) {
			const original = await this.repository.getMessage(
				parsed.replyToMessageId,
			);
			if (!original || original.conversationId !== conversationId) {
				throw new HttpError(
					400,
					"Reply target must be an existing message in this conversation",
				);
			}
		}
		if (parsed.attachment?.type === "gif") {
			if (!(await this.repository.gifExists(parsed.attachment.gifId)))
				throw new HttpError(404, "GIF not found");
		} else if (parsed.attachment) {
			const media = await this.repository.getMedia(parsed.attachment.mediaId);
			if (
				!media ||
				media.conversationId !== conversationId ||
				media.uploaderId !== userId
			)
				throw new HttpError(
					403,
					"Upload your attachment to this conversation first",
				);
			if (media.type !== parsed.attachment.type)
				throw new HttpError(400, "Attachment type does not match the upload");
		}
		return this.saveMessage({
			conversationId,
			senderId: userId,
			text: parsed.text ?? null,
			replyToMessageId: parsed.replyToMessageId ?? null,
			attachment: parsed.attachment ?? null,
			forwardedFrom: null,
		});
	}

	private async saveMessage(input: Omit<Message, "id" | "createdAt">) {
		const message = await this.repository.createMessage(input);
		await this.publish(message.conversationId, "message.created", { message });
		return message;
	}

	async getMessage(userId: string, conversationId: string, messageId: string) {
		await this.requireMember(userId, conversationId);
		const message = await this.repository.getMessage(messageId);
		if (!message || message.conversationId !== conversationId)
			throw new HttpError(404, "Message not found");
		return {
			...message,
			reactions: await this.repository.listReactions([message.id]),
		};
	}

	async listMessages(
		userId: string,
		conversationId: string,
		limit: number,
		beforeId?: string,
	): Promise<MessagePage> {
		await this.requireMember(userId, conversationId);
		let before: Message | undefined;
		if (beforeId) {
			before = await this.repository.getMessage(beforeId);
			if (!before || before.conversationId !== conversationId)
				throw new HttpError(400, "Invalid message cursor");
		}
		const records = await this.repository.listMessages(
			conversationId,
			limit + 1,
			before,
		);
		const page = records.slice(0, limit);
		const reactions = await this.repository.listReactions(
			page.map((message) => message.id),
		);
		return {
			messages: page.map((message) => ({
				...message,
				reactions: reactions.filter(
					(reaction) => reaction.messageId === message.id,
				),
			})),
			nextCursor: records.length > limit ? page.at(-1)!.id : null,
		};
	}

	async getMessagesAround(
		userId: string,
		conversationId: string,
		messageId: string,
		beforeCount = 50,
		afterCount = 50,
	) {
		const counts = parseInput(aroundMessagesSchema, {
			before: beforeCount,
			after: afterCount,
		});
		await this.requireMember(userId, conversationId);
		const target = await this.repository.getMessage(messageId);
		if (!target || target.conversationId !== conversationId)
			throw new HttpError(404, "Message not found");
		const [older, newer] = await Promise.all([
			this.repository.listMessages(conversationId, counts.before + 1, target),
			this.repository.listMessagesAfter(
				conversationId,
				counts.after + 1,
				target,
			),
		]);
		const before = older.slice(0, counts.before).reverse();
		const after = newer.slice(0, counts.after);
		const reactions = await this.repository.listReactions(
			[...before, target, ...after].map((message) => message.id),
		);
		const withReactions = (message: Message) => ({
			...message,
			reactions: reactions.filter(
				(reaction) => reaction.messageId === message.id,
			),
		});
		return {
			message: withReactions(target),
			before: before.map(withReactions),
			after: after.map(withReactions),
			hasMoreBefore: older.length > counts.before,
			hasMoreAfter: newer.length > counts.after,
		};
	}

	async forwardMessage(
		userId: string,
		destinationId: string,
		messageId: string,
	) {
		await this.requireMember(userId, destinationId);
		const source = await this.repository.getMessage(messageId);
		if (!source) throw new HttpError(404, "Message not found");
		await this.requireMember(userId, source.conversationId);
		let attachment = source.attachment;
		if (attachment && attachment.type !== "gif") {
			const sourceMedia = await this.repository.getMedia(attachment.mediaId);
			if (!sourceMedia) throw new HttpError(404, "Attachment not found");
			const { id, createdAt, ...metadata } = sourceMedia;
			const copied = await this.repository.createMedia({
				...metadata,
				conversationId: destinationId,
				uploaderId: userId,
			});
			attachment = { type: copied.type, mediaId: copied.id };
		}
		return this.saveMessage({
			conversationId: destinationId,
			senderId: userId,
			text: source.text,
			replyToMessageId: null,
			attachment,
			forwardedFrom: source.forwardedFrom ?? {
				messageId: source.id,
				conversationId: source.conversationId,
				senderId: source.senderId,
			},
		});
	}

	async react(
		userId: string,
		conversationId: string,
		messageId: string,
		emoji: ReactionEmoji,
		remove = false,
	) {
		parseInput(reactionSchema, { emoji });
		await this.requireMember(userId, conversationId);
		const message = await this.repository.getMessage(messageId);
		if (!message || message.conversationId !== conversationId)
			throw new HttpError(404, "Message not found");
		if (remove) await this.repository.removeReaction(messageId, userId, emoji);
		else await this.repository.addReaction(messageId, userId, emoji);
		await this.publish(conversationId, "message.reaction_changed", {
			conversationId,
			messageId,
			userId,
			emoji,
			removed: remove,
		});
	}

	async uploadAttachment(
		userId: string,
		conversationId: string,
		file: { buffer: Buffer; mimetype: string; originalname: string },
		kind?: "music",
	) {
		await this.requireMember(userId, conversationId);
		if (!file.buffer.length || file.buffer.length > MAX_ATTACHMENT_SIZE_BYTES)
			throw new HttpError(400, "Attachments must be between 1 byte and 50 MB");
		const contentType = file.mimetype;
		if (contentType === "image/gif")
			throw new HttpError(
				400,
				"Upload GIFs through /api/gifs, then use their GIF ID",
			);
		let type: MediaType = contentType.startsWith("image/")
			? "image"
			: contentType.startsWith("video/")
				? "video"
				: contentType.startsWith("audio/")
					? "audio"
					: "document";
		if (kind) {
			if (type !== "audio")
				throw new HttpError(400, "Music must be an audio file");
			type = "music";
		}
		const dimensions =
			type === "image" || type === "video"
				? await this.dimensions.read(file.buffer, type)
				: { width: null, height: null };
		const thumbnail =
			type === "video" ? await this.thumbnails.generate(file.buffer) : null;
		const thumbnailKey = thumbnail
			? `thumbnails/attachments/${conversationId}/${randomUUID()}.jpg`
			: null;
		const objectKey = `attachments/${conversationId}/${randomUUID()}`;
		let media: Media;
		try {
			await this.storage.putObject({
				key: objectKey,
				body: file.buffer,
				contentType,
			});
			if (thumbnail && thumbnailKey)
				await this.storage.putObject({
					key: thumbnailKey,
					body: thumbnail,
					contentType: "image/jpeg",
				});
			media = await this.repository.createMedia({
				conversationId,
				uploaderId: userId,
				type,
				objectKey,
				thumbnailKey,
				fileName: file.originalname,
				contentType,
				fileSize: file.buffer.length,
				...dimensions,
			});
		} catch (error) {
			await Promise.allSettled([
				this.storage.deleteObject(objectKey),
				...(thumbnailKey ? [this.storage.deleteObject(thumbnailKey)] : []),
			]);
			throw error;
		}
		return this.withThumbnailUrl(media);
	}

	private async findAttachment(
		userId: string,
		conversationId: string,
		mediaId: string,
	) {
		await this.requireMember(userId, conversationId);
		const media = await this.repository.getMedia(mediaId);
		if (!media || media.conversationId !== conversationId)
			throw new HttpError(404, "Attachment not found");
		return media;
	}

	private async withThumbnailUrl(media: Media) {
		return {
			...media,
			thumbnailUrl: media.thumbnailKey
				? await this.storage.getThumbnailUrl(media.thumbnailKey)
				: null,
		};
	}

	async getAttachment(userId: string, conversationId: string, mediaId: string) {
		return this.withThumbnailUrl(
			await this.findAttachment(userId, conversationId, mediaId),
		);
	}

	async downloadAttachment(
		userId: string,
		conversationId: string,
		mediaId: string,
	) {
		const media = await this.findAttachment(userId, conversationId, mediaId);
		return { media, body: await this.storage.getObject(media.objectKey) };
	}
}
