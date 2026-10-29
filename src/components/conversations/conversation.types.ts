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
	type: "private" | "group" | "saved";
	name: string | null;
	privateKey: string | null;
	savedMessagesOwnerId: string | null;
	inviteToken: string | null;
	createdAt: Date;
};
export type Member = {
	conversationId: string;
	userId: string;
	role: MemberRole;
	joinedAt: Date;
	lastSeenMessageId: string | null;
	lastSeen?: Date | null;
};
export type MediaType =
	"image" | "video" | "audio" | "music" | "voice" | "document";
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
	title: string | null;
	artist: string | null;
	coverKey: string | null;
	contentType: string;
	fileSize: number;
	width: number | null;
	height: number | null;
	durationSeconds: number | null;
	createdAt: Date;
};
export type GifMetadata = {
	id: string;
	userId: string;
	objectKey: string;
	thumbnailKey: string | null;
	fileSize: number;
	width: number | null;
	height: number | null;
	createdAt: Date;
	playbackUrl: string;
	thumbnailUrl: string | null;
};
export type NewMedia = Omit<
	Media,
	"id" | "createdAt" | "title" | "artist" | "coverKey"
> &
	Partial<Pick<Media, "title" | "artist" | "coverKey">>;
export type MessageWithMetadata = Message & {
	attachmentMetadata:
		| (Media & { thumbnailUrl: string | null; coverUrl: string | null })
		| GifMetadata
		| null;
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
	isEdited: boolean;
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
	messages: (MessageWithMetadata & { reactions: Reaction[] })[];
	nextCursor: string | null;
};

export type ReadState = {
	lastSeenMessageId: string | null;
	unreadCount: number;
};
export type Mention = {
	userId: string;
	conversationId: string;
	messageId: string;
	seen: boolean;
};
export type ConversationListItem = Conversation & ReadState;
