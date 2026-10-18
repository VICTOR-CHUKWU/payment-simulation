import type { Logger } from "pino";

export interface ClosableServer {
  close: (callback: (err?: Error) => void) => unknown;
}

export type ShutdownTask = () => Promise<void> | void;

export interface ShutdownOptions {
  logger?: Logger;
  server: ClosableServer;
  tasks?: ShutdownTask[];
  timeoutMs?: number;
}

function closeServer(server: ClosableServer): Promise<Error | undefined> {
  return new Promise((resolve) => {
    server.close((err) => resolve(err));
  });
}

export function createShutdown({
  logger,
  server,
  tasks = [],
}: ShutdownOptions): () => Promise<0 | 1> {
  let pending: Promise<0 | 1> | undefined;

  const run = async (): Promise<0 | 1> => {
    logger?.info("shutdown started");
    const closeError = await closeServer(server);
    let ok = !closeError;
    if (closeError) {
      logger?.error({ err: closeError }, "closing the HTTP server failed");
    }
    for (const [index, task] of tasks.entries()) {
      try {
        // biome-ignore lint/performance/noAwaitInLoops: tasks must run in order
        await task();
      } catch (err) {
        ok = false;
        logger?.error({ err, task: index }, "shutdown task failed");
      }
    }
    const code = ok ? 0 : 1;
    logger?.info({ exitCode: code }, "shutdown finished");
    return code;
  };

  return () => {
    pending ??= run();
    return pending;
  };
}

export function onShutdown(options: ShutdownOptions): void {
  const { logger, timeoutMs = 10_000 } = options;
  const shutdown = createShutdown(options);

  const handle = async (signal: NodeJS.Signals) => {
    logger?.info({ signal }, "shutdown signal received");
    setTimeout(() => {
      logger?.fatal({ timeoutMs }, "shutdown timed out");
      process.exit(1);
    }, timeoutMs).unref();
    process.exitCode = await shutdown();
  };

  process.once("SIGTERM", handle);
  process.once("SIGINT", handle);
}
