ALTER TABLE "runs" ADD COLUMN "kind" text DEFAULT 'initial' NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "parent_run_id" uuid;--> statement-breakpoint
-- workspace_key is NOT NULL with no default, and Postgres cannot default a
-- column to another column of the same row — so it arrives nullable, is
-- backfilled from the id (every existing run's directory is named after it,
-- which is precisely the identity this column generalizes), and is constrained
-- afterwards. Hand-written: drizzle-kit emits the NOT NULL add alone, which
-- fails on any table that already has rows.
ALTER TABLE "runs" ADD COLUMN "workspace_key" uuid;--> statement-breakpoint
UPDATE "runs" SET "workspace_key" = "id" WHERE "workspace_key" IS NULL;--> statement-breakpoint
ALTER TABLE "runs" ALTER COLUMN "workspace_key" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_parent_run_id_runs_id_fk" FOREIGN KEY ("parent_run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "runs_workspace_key_idx" ON "runs" USING btree ("workspace_key");