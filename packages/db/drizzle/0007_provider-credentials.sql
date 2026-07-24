CREATE TABLE "provider_credentials" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"base_url" text,
	"secret_ref" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "provider_credentials" ADD CONSTRAINT "provider_credentials_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_credentials" ADD CONSTRAINT "provider_credentials_secret_ref_secrets_id_fk" FOREIGN KEY ("secret_ref") REFERENCES "public"."secrets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "provider_credentials_uq" ON "provider_credentials" USING btree ("project_id","provider");