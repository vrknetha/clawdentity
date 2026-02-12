import { type DrizzleD1Database, drizzle } from "drizzle-orm/d1";
import * as schema from "./schema.js";

type RegistryDb = DrizzleD1Database<typeof schema>;

const databaseCache = new WeakMap<D1Database, RegistryDb>();

export function createDb(database: D1Database): RegistryDb {
  const cachedDatabase = databaseCache.get(database);
  if (cachedDatabase) {
    return cachedDatabase;
  }

  const db = drizzle(database, { schema });
  databaseCache.set(database, db);
  return db;
}
