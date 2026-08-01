ALTER TABLE "runs" ADD COLUMN "lease_owner" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "runs_lease_sweep_idx" ON "runs" USING btree ("lease_expires_at") WHERE "runs"."status" = 'running';