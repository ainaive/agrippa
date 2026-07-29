ALTER TABLE "models" ADD COLUMN "rank" integer DEFAULT 100 NOT NULL;--> statement-breakpoint
-- Backfill preserves the preference order the price columns used to imply, so
-- an upgraded deployment resolves exactly the models it resolved yesterday.
-- Spaced by 10 to leave room for slotting new models between existing ones;
-- ties break as resolveSlotModels always did — provider, then model id.
UPDATE "models" AS m
SET "rank" = o.r
FROM (
  SELECT
    id,
    (row_number() OVER (
      ORDER BY
        coalesce("input_cost_per_mtok", 0),
        coalesce("output_cost_per_mtok", 0),
        "provider",
        "provider_model_id"
    ) * 10)::integer AS r
  FROM "models"
) AS o
WHERE m.id = o.id;
