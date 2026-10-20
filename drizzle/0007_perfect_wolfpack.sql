ALTER TABLE "conversation_media" ADD COLUMN "width" integer;--> statement-breakpoint
ALTER TABLE "conversation_media" ADD COLUMN "height" integer;--> statement-breakpoint
ALTER TABLE "gifs" ADD COLUMN "width" integer;--> statement-breakpoint
ALTER TABLE "gifs" ADD COLUMN "height" integer;--> statement-breakpoint
ALTER TABLE "conversation_media" ADD CONSTRAINT "conversation_media_dimensions_required" CHECK (("conversation_media"."type" IN ('image', 'video') AND "conversation_media"."width" IS NOT NULL AND "conversation_media"."height" IS NOT NULL AND "conversation_media"."width" > 0 AND "conversation_media"."height" > 0) OR ("conversation_media"."type" NOT IN ('image', 'video') AND "conversation_media"."width" IS NULL AND "conversation_media"."height" IS NULL)) NOT VALID;--> statement-breakpoint
ALTER TABLE "gifs" ADD CONSTRAINT "gifs_dimensions_required" CHECK ("gifs"."width" IS NOT NULL AND "gifs"."height" IS NOT NULL AND "gifs"."width" > 0 AND "gifs"."height" > 0) NOT VALID;