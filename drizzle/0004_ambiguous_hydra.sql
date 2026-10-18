CREATE TABLE "gifs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"object_key" text NOT NULL,
	"file_size" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gifs_object_key_unique" UNIQUE("object_key")
);
--> statement-breakpoint
INSERT INTO "gifs" ("id", "user_id", "object_key", "file_size", "created_at") SELECT "id", "user_id", "object_key", "file_size", "created_at" FROM "user_gifs";--> statement-breakpoint
ALTER TABLE "user_gifs" ADD COLUMN "gif_id" uuid;--> statement-breakpoint
UPDATE "user_gifs" SET "gif_id" = "id";--> statement-breakpoint
ALTER TABLE "user_gifs" ALTER COLUMN "gif_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "user_gifs" DROP CONSTRAINT "user_gifs_pkey";--> statement-breakpoint
ALTER TABLE "user_gifs" DROP CONSTRAINT "user_gifs_object_key_unique";--> statement-breakpoint
ALTER TABLE "user_gifs" ADD CONSTRAINT "user_gifs_user_id_gif_id_pk" PRIMARY KEY("user_id","gif_id");--> statement-breakpoint
ALTER TABLE "gifs" ADD CONSTRAINT "gifs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_gifs" ADD CONSTRAINT "user_gifs_gif_id_gifs_id_fk" FOREIGN KEY ("gif_id") REFERENCES "public"."gifs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_gifs" DROP COLUMN "id";--> statement-breakpoint
ALTER TABLE "user_gifs" DROP COLUMN "object_key";--> statement-breakpoint
ALTER TABLE "user_gifs" DROP COLUMN "file_size";
