ALTER TABLE "worker_heartbeats" ADD COLUMN "executors" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "worker_heartbeats" ADD COLUMN "version" text;