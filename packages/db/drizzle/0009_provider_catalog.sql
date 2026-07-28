CREATE TABLE "provider_catalog" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid,
	"provider_id" text NOT NULL,
	"label" text NOT NULL,
	"base_urls" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"auth" text NOT NULL,
	"base_url_hosts" jsonb,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_catalog_provider_id_unique" UNIQUE("provider_id")
);
--> statement-breakpoint
ALTER TABLE "provider_catalog" ADD CONSTRAINT "provider_catalog_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;