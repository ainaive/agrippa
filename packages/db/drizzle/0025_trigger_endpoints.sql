CREATE TABLE "trigger_deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"external_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"payload" jsonb,
	"task_id" uuid,
	"run_id" uuid,
	"last_error" text,
	"last_attempt_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trigger_endpoints" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"task_type_id" uuid NOT NULL,
	"name" text NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"agent_overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"token_hash" text NOT NULL,
	"token_prefix" text NOT NULL,
	"secret_ref" uuid NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"disabled_reason" text,
	"last_fired_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "trigger_deliveries" ADD CONSTRAINT "trigger_deliveries_endpoint_id_trigger_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."trigger_endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trigger_deliveries" ADD CONSTRAINT "trigger_deliveries_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trigger_deliveries" ADD CONSTRAINT "trigger_deliveries_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trigger_deliveries" ADD CONSTRAINT "trigger_deliveries_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trigger_endpoints" ADD CONSTRAINT "trigger_endpoints_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trigger_endpoints" ADD CONSTRAINT "trigger_endpoints_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trigger_endpoints" ADD CONSTRAINT "trigger_endpoints_task_type_id_task_types_id_fk" FOREIGN KEY ("task_type_id") REFERENCES "public"."task_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trigger_endpoints" ADD CONSTRAINT "trigger_endpoints_secret_ref_secrets_id_fk" FOREIGN KEY ("secret_ref") REFERENCES "public"."secrets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trigger_endpoints" ADD CONSTRAINT "trigger_endpoints_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "trigger_deliveries_dedupe_uq" ON "trigger_deliveries" USING btree ("endpoint_id","external_id") WHERE "trigger_deliveries"."external_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "trigger_deliveries_project_idx" ON "trigger_deliveries" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "trigger_deliveries_pending_idx" ON "trigger_deliveries" USING btree ("created_at") WHERE "trigger_deliveries"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "trigger_endpoints_token_prefix_uq" ON "trigger_endpoints" USING btree ("token_prefix");--> statement-breakpoint
CREATE INDEX "trigger_endpoints_project_idx" ON "trigger_endpoints" USING btree ("project_id");