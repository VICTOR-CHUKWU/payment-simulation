import { type ClosableServer, createShutdown } from "./shutdown.js";

function setup(options: { closeError?: Error; failTask?: string } = {}) {
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
});
