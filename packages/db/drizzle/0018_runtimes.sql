CREATE TABLE "runtimes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_prefix" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"hostname" text,
	"version" text,
	"executors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_seen_at" timestamp with time zone,
	"registered_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "actor_runtime_id" uuid;--> statement-breakpoint
ALTER TABLE "runtimes" ADD CONSTRAINT "runtimes_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtimes" ADD CONSTRAINT "runtimes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "runtimes_token_prefix_uq" ON "runtimes" USING btree ("token_prefix");--> statement-breakpoint
CREATE INDEX "runtimes_org_status_idx" ON "runtimes" USING btree ("org_id","status");--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_runtime_id_runtimes_id_fk" FOREIGN KEY ("actor_runtime_id") REFERENCES "public"."runtimes"("id") ON DELETE no action ON UPDATE no action;