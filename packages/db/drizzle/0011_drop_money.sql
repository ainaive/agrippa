ALTER TABLE "project_quotas" DROP COLUMN "cost_limit_usd";--> statement-breakpoint
ALTER TABLE "models" DROP COLUMN "input_cost_per_mtok";--> statement-breakpoint
ALTER TABLE "models" DROP COLUMN "output_cost_per_mtok";--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN "budget";--> statement-breakpoint
ALTER TABLE "token_usage" DROP COLUMN "cost_usd";