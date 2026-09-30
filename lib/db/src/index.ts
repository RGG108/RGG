import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

function normalizeDatabaseCa(value: string | undefined) {
  if (!value) return undefined;

  const beginMarker = "-----BEGIN CERTIFICATE-----";
  const endMarker = "-----END CERTIFICATE-----";

  const normalized = value
    .replaceAll("\\n", "\n")
    .replace(/\\r/g, "")
    .replace(/\r/g, "");

  const begin = normalized.indexOf(beginMarker);
  const end = normalized.indexOf(endMarker);

  if (begin === -1 || end === -1 || end < begin) {
    return normalized.trim();
  }

  return normalized
    .slice(begin, end + endMarker.length)
    .trim();
}

function databaseSslOptions(environment: NodeJS.ProcessEnv) {
  const enabled =
    environment.DATABASE_SSL?.toLowerCase() === "true" ||
    ["require", "verify-ca", "verify-full"].includes(
      environment.PGSSLMODE?.toLowerCase() ?? "",
    );

  if (!enabled) return undefined;

  const ca = normalizeDatabaseCa(environment.DATABASE_SSL_CA);

  return {
    // Hostinger PostgreSQL uses a self-signed server certificate.
    // Keep the database connection encrypted with TLS, but do not
    // require Node to validate that certificate against a public CA.
    rejectUnauthorized: false,
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
