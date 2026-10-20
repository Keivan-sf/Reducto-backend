export const REACTION_EMOJIS = [
	"👍",
	"👎",
	"❤️",
	"😂",
	"😮",
	"😢",
	"🔥",
	"🎉",
] as const;
export type ReactionEmoji = (typeof REACTION_EMOJIS)[number];
export type MemberRole = "owner" | "admin" | "member";
export type Conversation = {
	id: string;
	type: "private" | "group";
	name: string | null;
	privateKey: string | null;
	inviteToken: string | null;
	createdAt: Date;
};
export type Member = {
	conversationId: string;
	userId: string;
	role: MemberRole;
	joinedAt: Date;
};
export type MediaType = "image" | "video" | "audio" | "music" | "document";
export type Attachment =
	{ type: "gif"; gifId: string } | { type: MediaType; mediaId: string };
export type Media = {
	id: string;
	conversationId: string;
	uploaderId: string;
	type: MediaType;
	objectKey: string;
	thumbnailKey: string | null;
	fileName: string;
	contentType: string;
	fileSize: number;
	width: number | null;
	height: number | null;
	createdAt: Date;
};
export type ForwardOrigin = {
	messageId: string;
	conversationId: string;
	senderId: string;
};
export type Message = {
	id: string;
	conversationId: string;
	senderId: string;
	text: string | null;
	replyToMessageId: string | null;
	attachment: Attachment | null;
	forwardedFrom: ForwardOrigin | null;
	createdAt: Date;
};
export type Reaction = {
	messageId: string;
	userId: string;
	emoji: ReactionEmoji;
};
export type NewMessage = {
	text?: string;
	attachment?: Attachment;
	replyToMessageId?: string;
};
export type MessagePage = {
	messages: (Message & { reactions: Reaction[] })[];
	nextCursor: string | null;
};
