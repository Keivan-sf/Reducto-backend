CREATE TABLE "message_encryption" (
	"id" integer PRIMARY KEY NOT NULL,
	"salt" text NOT NULL,
	"verification" text NOT NULL,
	CONSTRAINT "message_encryption_singleton" CHECK ("message_encryption"."id" = 1)
);
