ALTER TABLE "users" ADD COLUMN "name" text NOT NULL DEFAULT 'Unknown';--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "name" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "username" text;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_username_unique" UNIQUE("username");
