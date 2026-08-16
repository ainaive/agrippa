ALTER TABLE "worker_heartbeats" ADD COLUMN "workspace_host" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "workspace_host" text;