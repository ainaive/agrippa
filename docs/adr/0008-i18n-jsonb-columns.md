# ADR-0008: jsonb `{en, zh-CN}` Columns for DB-Stored Localizable Metadata

- Status: accepted · Date: 2026-07-17

## Context

Scenario names, task-type descriptions, template labels, and Faber personas are data, not code — they can't live in locale JSON files. The platform ships exactly two locales (en, zh-CN) with no near-term plan for more.

## Decision

Localizable DB fields are `jsonb` columns of shape `{"en": "...", "zh-CN": "..."}` (`name_i18n`, `description_i18n`, …). A single shared helper `pickLocale(obj, locale)` in `@agrippa/core` implements the fallback chain (requested → `en` → first available) for API serializers and the SPA alike. Template YAML uses the identical shape, so compiled inputs localize UI forms with no extra machinery. The template compiler rejects missing locales; a CI check enforces en/zh-CN key parity in the static locale files.

## Alternatives considered

- **Translation join tables** (`entity_translations(entity_id, locale, field, value)`): the "correct" normalization for N locales, but for two locales it buys nothing except joins on every read and a much clumsier authoring/edit path.
- **Separate columns** (`name_en`, `name_zh_cn`): no joins, but schema churn per locale and per field, and the shape can't be shared with YAML/compiled-JSON documents.

## Consequences

- Reads are single-row; writing/editing bilingual metadata is one object.
- Adding a third locale is additive (new key in jsonb + locale files + parity check) — no migration.
- Full-text search over localized fields would need expression indexes per locale key; acceptable, and out of scope for M1.
