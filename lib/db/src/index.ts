import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

function databaseSslOptions(environment: NodeJS.ProcessEnv) {
  const enabled =
    environment.DATABASE_SSL?.toLowerCase() === "true" ||
    ["require", "verify-ca", "verify-full"].includes(
      environment.PGSSLMODE?.toLowerCase() ?? "",
    );
  if (!enabled) return undefined;
  return {
    rejectUnauthorized: true,
    ...(environment.DATABASE_SSL_CA
      ? { ca: environment.DATABASE_SSL_CA.replaceAll("\\n", "\n") }
      : {}),
  };
}

function databaseConnectionString(environment: NodeJS.ProcessEnv) {
  const connectionString = environment.DATABASE_URL!;
  if (!databaseSslOptions(environment)) return connectionString;
  const parsed = new URL(connectionString);
  for (const name of [
    "sslmode",
    "sslrootcert",
    "sslcert",
    "sslkey",
    "uselibpqcompat",
  ]) {
    parsed.searchParams.delete(name);
  }
  return parsed.toString();
}

export const pool = new Pool({
  connectionString: databaseConnectionString(process.env),
  connectionTimeoutMillis: 5000,
  ssl: databaseSslOptions(process.env),
});
export const db = drizzle(pool, { schema });

export * from "./schema";
