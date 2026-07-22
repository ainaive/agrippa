CREATE TABLE "run_comments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "approvals" RENAME TO "checkpoints";--> statement-breakpoint
ALTER TABLE "checkpoints" DROP CONSTRAINT "approvals_run_id_runs_id_fk";
--> statement-breakpoint
ALTER TABLE "checkpoints" DROP CONSTRAINT "approvals_step_id_run_steps_id_fk";
--> statement-breakpoint
ALTER TABLE "checkpoints" DROP CONSTRAINT "approvals_decided_by_users_id_fk";
--> statement-breakpoint
DROP INDEX "run_steps_uq";--> statement-breakpoint
ALTER TABLE "checkpoints" ADD COLUMN "kind" text DEFAULT 'approval' NOT NULL;--> statement-breakpoint
ALTER TABLE "checkpoints" ADD COLUMN "iteration" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "checkpoints" ADD COLUMN "response" jsonb;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "iteration" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "run_steps" ADD COLUMN "iteration" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "agent_bindings" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "work_branch" text;--> statement-breakpoint
ALTER TABLE "run_comments" ADD CONSTRAINT "run_comments_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_comments" ADD CONSTRAINT "run_comments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "run_comments_run_idx" ON "run_comments" USING btree ("run_id","created_at");--> statement-breakpoint
ALTER TABLE "checkpoints" ADD CONSTRAINT "checkpoints_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkpoints" ADD CONSTRAINT "checkpoints_step_id_run_steps_id_fk" FOREIGN KEY ("step_id") REFERENCES "public"."run_steps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkpoints" ADD CONSTRAINT "checkpoints_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "checkpoints_run_ckpt_iter_uq" ON "checkpoints" USING btree ("run_id","checkpoint_id","iteration");--> statement-breakpoint
CREATE UNIQUE INDEX "run_steps_uq" ON "run_steps" USING btree ("run_id","phase_id","step_id","iteration","attempt");