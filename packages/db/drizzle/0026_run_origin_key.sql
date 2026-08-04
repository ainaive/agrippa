ALTER TABLE "runs" ADD COLUMN "origin_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "runs_origin_key_uq" ON "runs" USING btree ("origin_key") WHERE "runs"."origin_key" IS NOT NULL;