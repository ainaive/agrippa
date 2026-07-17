import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import * as schema from "./schema";

export function createDb(url: string | undefined = process.env.DATABASE_URL) {
  if (!url) throw new Error("DATABASE_URL is not set");
  const client = new SQL({ url, max: 10 });
  return drizzle({ client, schema });
}

export type Db = ReturnType<typeof createDb>;
