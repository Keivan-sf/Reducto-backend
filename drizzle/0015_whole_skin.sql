CREATE TABLE "message_mentions" (
	"user_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"seen" boolean DEFAULT false NOT NULL,
	CONSTRAINT "message_mentions_message_id_user_id_pk" PRIMARY KEY("message_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "message_mentions" ADD CONSTRAINT "mentions_member_fk" FOREIGN KEY ("conversation_id","user_id") REFERENCES "public"."conversation_members"("conversation_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_mentions" ADD CONSTRAINT "mentions_message_same_conversation_fk" FOREIGN KEY ("conversation_id","message_id") REFERENCES "public"."messages"("conversation_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mentions_unseen_user_conversation_idx" ON "message_mentions" USING btree ("user_id","conversation_id") WHERE "message_mentions"."seen" = false;