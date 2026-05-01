import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export type Database = PostgresJsDatabase<typeof schema>;

let _db: Database | undefined;
let _client: ReturnType<typeof postgres> | undefined;

export function getDb(connectionString: string): Database {
  if (!_db) {
    _client = postgres(connectionString, { max: 10, prepare: false });
    _db = drizzle(_client, { schema });
  }
  return _db;
}

export async function closeDb(): Promise<void> {
  if (!_client) return;
  try {
    await _client.end();
  } finally {
    _client = undefined;
    _db = undefined;
  }
}
