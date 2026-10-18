CREATE TYPE "public"."conversation_type" AS ENUM('private', 'group');--> statement-breakpoint
CREATE TYPE "public"."media_type" AS ENUM('image', 'video', 'audio', 'music', 'document');--> statement-breakpoint
CREATE TYPE "public"."member_role" AS ENUM('owner', 'admin', 'member');--> statement-breakpoint
CREATE TYPE "public"."reaction_emoji" AS ENUM('👍', '👎', '❤️', '😂', '😮', '😢', '🔥', '🎉');--> statement-breakpoint
CREATE TABLE "conversation_media" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"uploader_id" uuid NOT NULL,
	"type" "media_type" NOT NULL,
	"object_key" text NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"file_size" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_members" (
	"conversation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "member_role" DEFAULT 'member' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_members_conversation_id_user_id_pk" PRIMARY KEY("conversation_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" "conversation_type" NOT NULL,
	"name" text,
	"private_key" text,
	"invite_token" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversations_private_key_unique" UNIQUE("private_key"),
	CONSTRAINT "conversations_invite_token_unique" UNIQUE("invite_token")
);
--> statement-breakpoint
CREATE TABLE "message_reactions" (
	"message_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"emoji" "reaction_emoji" NOT NULL,
	CONSTRAINT "message_reactions_message_id_user_id_emoji_pk" PRIMARY KEY("message_id","user_id","emoji")
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"sender_id" uuid NOT NULL,
	"text" text,
	"attachment" jsonb,
	"forwarded_from" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversation_media" ADD CONSTRAINT "conversation_media_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_media" ADD CONSTRAINT "conversation_media_uploader_id_users_id_fk" FOREIGN KEY ("uploader_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_members" ADD CONSTRAINT "conversation_members_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_members" ADD CONSTRAINT "conversation_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_reactions" ADD CONSTRAINT "message_reactions_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_reactions" ADD CONSTRAINT "message_reactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_id_users_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "members_user_idx" ON "conversation_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "messages_conversation_created_idx" ON "messages" USING btree ("conversation_id","created_at","id");