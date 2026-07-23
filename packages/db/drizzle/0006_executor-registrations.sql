CREATE TABLE "executor_registrations" (
	"executor_id" text PRIMARY KEY NOT NULL,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL
);
