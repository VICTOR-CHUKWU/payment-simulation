import { Writable } from "node:stream";
import { createLogger, type Logger } from "./logger.js";
import { type ClosableServer, createShutdown, onShutdown } from "./shutdown.js";

const { jest } = import.meta;

function captureLogger() {
  const lines: Record<string, unknown>[] = [];
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      for (const line of chunk.toString().split("\n").filter(Boolean)) {
        lines.push(JSON.parse(line));
      }
      callback();
    },
  });
  const logger = createLogger({
    destination,
    level: "info",
    pretty: false,
    service: "test",
  });
  return { lines, logger };
}

function setup(
  options: { closeError?: Error; failTask?: string; logger?: Logger } = {}
) {
  const calls: string[] = [];
  const server: ClosableServer = {
    close(callback) {
      calls.push("close");
      callback(options.closeError);
      return this;
    },
  };
  const task = (name: string) => async () => {
    await Promise.resolve();
    calls.push(name);
    if (name === options.failTask) {
      throw new Error(`${name} failed`);
    }
  };
  const shutdown = createShutdown({
    logger: options.logger,
    server,
    tasks: [task("first"), task("second"), task("third")],
  });
  return { calls, shutdown };
}

describe("createShutdown", () => {
  it("closes the server, then runs tasks in order, and returns 0", async () => {
    const { calls, shutdown } = setup();
    await expect(shutdown()).resolves.toBe(0);
    expect(calls).toEqual(["close", "first", "second", "third"]);
  });

  it("returns 1 when closing fails and still runs the tasks", async () => {
    const { calls, shutdown } = setup({ closeError: new Error("busy") });
    await expect(shutdown()).resolves.toBe(1);
    expect(calls).toEqual(["close", "first", "second", "third"]);
  });

  it("returns 1 when a task throws and runs later tasks", async () => {
    const { calls, shutdown } = setup({ failTask: "second" });
    await expect(shutdown()).resolves.toBe(1);
    expect(calls).toEqual(["close", "first", "second", "third"]);
  });

  it("runs once when called again", async () => {
    const { calls, shutdown } = setup();
    const first = shutdown();
    expect(shutdown()).toBe(first);
    await first;
    await shutdown();
    expect(calls).toEqual(["close", "first", "second", "third"]);
  });

  it("works without tasks", async () => {
    const server: ClosableServer = { close: (callback) => callback() };
    await expect(createShutdown({ server })()).resolves.toBe(0);
  });

  it("logs a failing task with its index and error", async () => {
    const { lines, logger } = captureLogger();
    const { shutdown } = setup({ failTask: "second", logger });
    await shutdown();
    expect(lines.map((line) => line.msg)).toEqual([
      "shutdown started",
      "shutdown task failed",
      "shutdown finished",
    ]);
    expect(lines[1]).toMatchObject({
      err: { message: "second failed" },
      level: 50,
      task: 1,
    });
    expect(lines[2]).toMatchObject({ exitCode: 1 });
  });

  it("logs a failed server close", async () => {
    const { lines, logger } = captureLogger();
    const { shutdown } = setup({ closeError: new Error("busy"), logger });
    await shutdown();
    expect(lines[1]).toMatchObject({
      err: { message: "busy" },
      level: 50,
      msg: "closing the HTTP server failed",
    });
  });
});

const closedServer: ClosableServer = {
  close(callback) {
    callback();
    return this;
  },
};

describe("onShutdown", () => {
  const handlers = new Map<string, (signal: NodeJS.Signals) => Promise<void>>();

  beforeEach(() => {
    handlers.clear();
    jest.spyOn(process, "once").mockImplementation(((
      event: string,
      handler: never
    ) => {
      handlers.set(event, handler);
      return process;
    }) as typeof process.once);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
    process.exitCode = undefined;
  });

  it("registers SIGTERM and SIGINT once and sets the exit code from the shutdown", async () => {
    const { lines, logger } = captureLogger();
    onShutdown({
      logger,
      server: closedServer,
      tasks: [() => Promise.reject(new Error("boom"))],
    });
    expect([...handlers.keys()].sort()).toEqual(["SIGINT", "SIGTERM"]);
    await handlers.get("SIGTERM")?.("SIGTERM");
    expect(process.exitCode).toBe(1);
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          msg: "shutdown signal received",
          signal: "SIGTERM",
        }),
      ])
    );
  });

  it("exits with 1 when the shutdown outlives the timeout", () => {
    jest.useFakeTimers();
    const exit = jest
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    const { lines, logger } = captureLogger();
    onShutdown({
      logger,
      server: closedServer,
      tasks: [() => new Promise<void>(() => undefined)],
      timeoutMs: 50,
    });
    handlers.get("SIGINT")?.("SIGINT");
    jest.advanceTimersByTime(50);
    expect(exit).toHaveBeenCalledWith(1);
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ msg: "shutdown timed out", timeoutMs: 50 }),
      ])
    );
  });
});
