import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import type { QueryConfig, QueryResult, QueryResultRow } from "pg";
import {
  HealthCheckResponse,
  ReadinessCheckResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();
const READINESS_QUERY_TIMEOUT_MS = 1_000;
const READINESS_RETRY_MIN_MS = 750;
const READINESS_RETRY_JITTER_MS = 500;
const READINESS_ADVISORY_LOCK_ID = 1_849_336_927;
type TimedQueryConfig = QueryConfig & { query_timeout: number };

type ReadinessClient = {
  query<Row extends QueryResultRow = QueryResultRow>(
    config: TimedQueryConfig,
  ): Promise<QueryResult<Row>>;
  release(destroy?: boolean): void;
};

type ReadinessPool = {
  connect(): Promise<ReadinessClient>;
};

type ReadinessProbeOptions = {
  now?: () => number;
  retryDelayMs?: () => number;
};

type ReadinessProbeResult =
  | {
      status: "ready";
      recovery?: {
        outageDurationMs: number;
        retryCacheResponses: number;
      };
    }
  | { status: "unavailable"; source: "fresh-check" | "retry-cache" };

export function createReadinessProbe(
  readinessPool: ReadinessPool,
  options: ReadinessProbeOptions = {},
) {
  const now = options.now ?? Date.now;
  const retryDelayMs =
    options.retryDelayMs ??
    (() =>
      READINESS_RETRY_MIN_MS +
      Math.floor(Math.random() * READINESS_RETRY_JITTER_MS));
  let retryAfter = 0;
  let outageStartedAt: number | undefined;
  let retryCacheResponses = 0;

  return async (): Promise<ReadinessProbeResult> => {
    const checkedAt = now();
    if (checkedAt < retryAfter) {
      retryCacheResponses += 1;
      return { status: "unavailable", source: "retry-cache" };
    }

    let client: ReadinessClient | undefined;
    let lockAcquired = false;
    try {
      client = await readinessPool.connect();
      const lockResult = await client.query<{ acquired: boolean }>({
        text: "SELECT pg_try_advisory_lock($1) AS acquired",
        values: [READINESS_ADVISORY_LOCK_ID],
        query_timeout: READINESS_QUERY_TIMEOUT_MS,
      } satisfies TimedQueryConfig);
      lockAcquired = lockResult.rows[0]?.acquired === true;

      if (!lockAcquired) {
        outageStartedAt ??= checkedAt;
        retryAfter = now() + retryDelayMs();
        return { status: "unavailable", source: "fresh-check" };
      }

      await client.query({
        text: "SELECT 1",
        query_timeout: READINESS_QUERY_TIMEOUT_MS,
      } satisfies TimedQueryConfig);
      retryAfter = 0;
      if (outageStartedAt === undefined) {
        return { status: "ready" };
      }

      const recovery = {
        outageDurationMs: Math.max(0, now() - outageStartedAt),
        retryCacheResponses,
      };
      outageStartedAt = undefined;
      retryCacheResponses = 0;
      return { status: "ready", recovery };
    } catch (error) {
      console.error("[readyz] PostgreSQL readiness failure", {
        name: error instanceof Error ? error.name : undefined,
        message: error instanceof Error ? error.message : String(error),
        code:
          typeof error === "object" && error !== null && "code" in error
            ? String(error.code)
            : undefined,
      });
      outageStartedAt ??= checkedAt;
      retryAfter = now() + retryDelayMs();
      return { status: "unavailable", source: "fresh-check" };
    } finally {
      if (client && lockAcquired) {
        try {
          const unlockResult = await client.query<{ unlocked: boolean }>({
            text: "SELECT pg_advisory_unlock($1) AS unlocked",
            values: [READINESS_ADVISORY_LOCK_ID],
            query_timeout: READINESS_QUERY_TIMEOUT_MS,
          } satisfies TimedQueryConfig);
          if (unlockResult.rows[0]?.unlocked !== true) {
            client.release(true);
            client = undefined;
          }
        } catch {
          client?.release(true);
          client = undefined;
        }
      }
      client?.release();
    }
  };
}

const rawDatabaseCa = process.env.DATABASE_SSL_CA ?? "";
const beginIndex = rawDatabaseCa.indexOf("-----BEGIN CERTIFICATE-----");
const endMarker = "-----END CERTIFICATE-----";
const endIndex = rawDatabaseCa.indexOf(endMarker);

const databaseCa =
  beginIndex >= 0 && endIndex >= beginIndex
    ? rawDatabaseCa
        .slice(beginIndex, endIndex + endMarker.length)
        .replaceAll("\\n", "\n")
        .replace(/\\r/g, "")
        .replace(/\r/g, "")
        .trim()
    : undefined;

console.log("[database-ssl-config]", {
  databaseSsl: process.env.DATABASE_SSL,
  pgSslMode: process.env.PGSSLMODE,
  caPresent: Boolean(databaseCa),
  caLength: databaseCa?.length ?? 0,
  caHasBegin: databaseCa?.includes("-----BEGIN CERTIFICATE-----") ?? false,
  caHasEnd: databaseCa?.includes("-----END CERTIFICATE-----") ?? false,
});

if (databaseCa) {
  import("node:crypto").then(({ X509Certificate }) => {
    try {
      const certificate = new X509Certificate(databaseCa);
      console.log("[database-ca-certificate]", {
        subject: certificate.subject,
        issuer: certificate.issuer,
        fingerprint256: certificate.fingerprint256,
      });
    } catch (error) {
      console.error("[database-ca-certificate] INVALID", error);
    }
  });
}

const checkReadiness = createReadinessProbe(pool);

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

router.get("/readyz", async (req, res): Promise<void> => {
  const readiness = await checkReadiness();
  if (readiness.status === "ready") {
    if (readiness.recovery) {
      req.log.info(
        {
          outageDurationMs: readiness.recovery.outageDurationMs,
          retryCacheResponses: readiness.recovery.retryCacheResponses,
        },
        "Database readiness recovered",
      );
    }
    res.json(ReadinessCheckResponse.parse({ status: "ready" }));
    return;
  }

  if (readiness.source === "fresh-check") {
    req.log.warn("Database readiness check failed or deferred");
  }
  res
    .status(503)
    .json(ReadinessCheckResponse.parse({ status: "unavailable" }));
});

export default router;
