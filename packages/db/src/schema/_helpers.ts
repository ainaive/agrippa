import { timestamp, uuid } from "drizzle-orm/pg-core";

/** UUIDv7 everywhere: time-ordered, index-friendly, safe to expose. */
export const uuidv7 = () => Bun.randomUUIDv7();

export const idCol = () => uuid("id").primaryKey().$defaultFn(uuidv7);

export const createdAtCol = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const tstz = (name: string) => timestamp(name, { withTimezone: true });
