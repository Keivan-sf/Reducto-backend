ALTER TABLE "messages" ADD COLUMN "reply_to_message_id" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_id_unique" UNIQUE("conversation_id","id");--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_reply_same_conversation_fk" FOREIGN KEY ("conversation_id","reply_to_message_id") REFERENCES "public"."messages"("conversation_id","id") ON DELETE no action ON UPDATE no action;
