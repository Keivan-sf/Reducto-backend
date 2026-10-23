ALTER TABLE "conversation_media" DROP CONSTRAINT "conversation_media_duration_required";--> statement-breakpoint
ALTER TABLE "conversation_media" ALTER COLUMN "duration_seconds" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "conversation_media" ALTER COLUMN "duration_seconds" DROP NOT NULL;--> statement-breakpoint
UPDATE "conversation_media" SET "duration_seconds" = NULL WHERE "type" NOT IN ('video', 'voice', 'music') AND "duration_seconds" = 0;--> statement-breakpoint
ALTER TABLE "conversation_media" ADD CONSTRAINT "conversation_media_duration_required" CHECK (("conversation_media"."type" IN ('video', 'voice', 'music') AND "conversation_media"."duration_seconds" IS NOT NULL AND "conversation_media"."duration_seconds" > 0) OR ("conversation_media"."type" NOT IN ('video', 'voice', 'music') AND "conversation_media"."duration_seconds" IS NULL)) NOT VALID;
