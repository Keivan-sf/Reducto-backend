-- Recreate the enum so the new value can be used within Drizzle's migration
-- transaction (ADD VALUE cannot be used until its transaction commits).
CREATE TYPE "public"."conversation_type_new" AS ENUM ('private', 'group', 'saved');--> statement-breakpoint
ALTER TABLE "conversations" ALTER COLUMN "type" TYPE "public"."conversation_type_new" USING "type"::text::"public"."conversation_type_new";--> statement-breakpoint
DROP TYPE "public"."conversation_type";--> statement-breakpoint
ALTER TYPE "public"."conversation_type_new" RENAME TO "conversation_type";--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "saved_messages_owner_id" uuid;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_saved_messages_owner_id_users_id_fk" FOREIGN KEY ("saved_messages_owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_saved_messages_owner_id_unique" UNIQUE("saved_messages_owner_id");--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "saved_messages_structure" CHECK (("conversations"."type" = 'saved' AND "conversations"."saved_messages_owner_id" IS NOT NULL AND "conversations"."name" IS NOT NULL AND "conversations"."name" = 'Saved Messages' AND "conversations"."private_key" IS NULL AND "conversations"."invite_token" IS NULL) OR ("conversations"."type" <> 'saved' AND "conversations"."saved_messages_owner_id" IS NULL));
--> statement-breakpoint
-- Existing accounts get the same default conversation as new signups.
INSERT INTO "conversations" ("type", "name", "saved_messages_owner_id")
SELECT 'saved', 'Saved Messages', "id" FROM "users";
--> statement-breakpoint
INSERT INTO "conversation_members" ("conversation_id", "user_id", "role")
SELECT "id", "saved_messages_owner_id", 'owner' FROM "conversations" WHERE "type" = 'saved';
--> statement-breakpoint
-- Protect the conversation itself even if a future write bypasses service checks.
CREATE FUNCTION protect_saved_messages_conversation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.type = 'saved' THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'Saved Messages cannot be deleted';
    END IF;
    IF NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'Saved Messages cannot be changed';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER protect_saved_messages_conversation
BEFORE UPDATE OR DELETE ON "conversations"
FOR EACH ROW EXECUTE FUNCTION protect_saved_messages_conversation();
--> statement-breakpoint
CREATE FUNCTION protect_saved_messages_member() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE saved_owner uuid;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT saved_messages_owner_id INTO saved_owner FROM conversations WHERE id = OLD.conversation_id;
    IF saved_owner IS NOT NULL THEN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Cannot leave or remove the Saved Messages member';
      END IF;
      IF (NEW.conversation_id, NEW.user_id, NEW.role, NEW.joined_at)
         IS DISTINCT FROM (OLD.conversation_id, OLD.user_id, OLD.role, OLD.joined_at) THEN
        RAISE EXCEPTION 'Saved Messages membership cannot be changed';
      END IF;
    END IF;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT saved_messages_owner_id INTO saved_owner FROM conversations WHERE id = NEW.conversation_id;
    IF saved_owner IS NOT NULL AND (NEW.user_id <> saved_owner OR NEW.role <> 'owner') THEN
      RAISE EXCEPTION 'Only the owner can belong to Saved Messages';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER protect_saved_messages_member
BEFORE INSERT OR UPDATE OR DELETE ON "conversation_members"
FOR EACH ROW EXECUTE FUNCTION protect_saved_messages_member();
