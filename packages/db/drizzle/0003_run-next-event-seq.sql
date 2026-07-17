ALTER TABLE "runs" ADD COLUMN "next_event_seq" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE "runs" SET "next_event_seq" = COALESCE(
  (SELECT MAX("seq") FROM "run_events" WHERE "run_events"."run_id" = "runs"."id"),
  0
);
