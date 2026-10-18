export interface ClosableServer {
  close: (callback: (err?: Error) => void) => unknown;
}

export type ShutdownTask = () => Promise<void> | void;

export interface ShutdownOptions {
  server: ClosableServer;
  tasks?: ShutdownTask[];
  timeoutMs?: number;
}

function closeServer(server: ClosableServer): Promise<boolean> {
  return new Promise((resolve) => {
    server.close((err) => resolve(!err));
  });
}

export function createShutdown({
  server,
  tasks = [],
}: ShutdownOptions): () => Promise<0 | 1> {
  let pending: Promise<0 | 1> | undefined;

  const run = async (): Promise<0 | 1> => {
    let ok = await closeServer(server);
    for (const task of tasks) {
      try {
        // biome-ignore lint/performance/noAwaitInLoops: tasks must run in order
        await task();
      } catch {
        ok = false;
      }
    }
    return ok ? 0 : 1;
  };

  return () => {
    pending ??= run();
    return pending;
  };
}

export function onShutdown(options: ShutdownOptions): void {
  const { timeoutMs = 10_000 } = options;
  const shutdown = createShutdown(options);

  const handle = async () => {
    setTimeout(() => process.exit(1), timeoutMs).unref();
    process.exitCode = await shutdown();
  };

  process.once("SIGTERM", handle);
  process.once("SIGINT", handle);
}
