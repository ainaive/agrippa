CREATE TABLE "dispatch_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"dispatch_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"event" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dispatches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"step_row_id" uuid NOT NULL,
	"runtime_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"abort_requested" boolean DEFAULT false NOT NULL,
	"payload" jsonb NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"last_contact_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "dispatch_events" ADD CONSTRAINT "dispatch_events_dispatch_id_dispatches_id_fk" FOREIGN KEY ("dispatch_id") REFERENCES "public"."dispatches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatches" ADD CONSTRAINT "dispatches_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatches" ADD CONSTRAINT "dispatches_step_row_id_run_steps_id_fk" FOREIGN KEY ("step_row_id") REFERENCES "public"."run_steps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatches" ADD CONSTRAINT "dispatches_runtime_id_runtimes_id_fk" FOREIGN KEY ("runtime_id") REFERENCES "public"."runtimes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dispatch_events_seq_uq" ON "dispatch_events" USING btree ("dispatch_id","seq");--> statement-breakpoint
CREATE INDEX "dispatches_claim_idx" ON "dispatches" USING btree ("runtime_id","created_at") WHERE "dispatches"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "dispatches_step_live_uq" ON "dispatches" USING btree ("step_row_id") WHERE "dispatches"."status" in ('pending', 'claimed');