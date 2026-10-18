import type { NatsConnection } from "@nats-io/transport-node";
import { Router } from "express";

export interface ReadinessCheck {
  check: () => boolean | Promise<boolean>;
  name: string;
}

async function runCheck(check: ReadinessCheck): Promise<boolean> {
  try {
    return (await check.check()) === true;
  } catch {
    return false;
  }
}

export function healthRouter(checks: ReadinessCheck[]): Router {
  const router = Router();

  router.get("/health/live", (_req, res) => {
    res.json({ status: "ok" });
  });

  router.get("/health/ready", async (_req, res) => {
    const results = await Promise.all(checks.map(runCheck));
    const ready = results.every(Boolean);
    const body = Object.fromEntries(
      checks.map((check, i) => [check.name, results[i] ? "ok" : "fail"])
    );
    res
      .status(ready ? 200 : 503)
      .json({ checks: body, status: ready ? "ok" : "fail" });
  });

  return router;
}

export function natsCheck(
  nc: Pick<NatsConnection, "isClosed" | "isDraining" | "flush">,
  timeoutMs = 1000
): ReadinessCheck {
  return {
    check: async () => {
      if (nc.isClosed() || nc.isDraining()) {
        return false;
      }
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      });
      const flush = nc.flush().then(
        () => true,
        () => false
      );
      try {
        return await Promise.race([flush, timeout]);
      } finally {
        clearTimeout(timer);
      }
    },
    name: "nats",
  };
}
