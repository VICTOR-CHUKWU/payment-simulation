import {
  createSimulatedGateway,
  DECLINE_REASONS,
} from "./processor.gateway.js";

const { jest } = import.meta;

const charge = {
  amount: 150_000,
  currency: "NGN",
  paymentId: "3f1c2b7a-9d4e-4a51-8c6b-2e7f0a9d1b34",
} as const;

function sequence(...values: number[]) {
  let index = 0;
  return () => {
    const value = values[index] ?? 0;
    index += 1;
    return value;
  };
}

function gateway(...randoms: number[]) {
  return createSimulatedGateway({
    failureRate: 0.2,
    maxDelayMs: 5000,
    minDelayMs: 1000,
    random: sequence(...randoms),
    timeoutRate: 0.05,
  });
}

describe("createSimulatedGateway", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("approves after a delay inside the configured range", async () => {
    const settled = jest.fn();
    const result = gateway(0.5, 0.5, 0.9)
      .charge(charge, { signal: new AbortController().signal })
      .then((value) => {
        settled(value);
        return value;
      });

    await jest.advanceTimersByTimeAsync(2999);
    expect(settled).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);

    await expect(result).resolves.toEqual({ outcome: "approved" });
  });

  it("declines with a reason from the fixed list", async () => {
    const result = gateway(0.5, 0, 0.1, 0.5).charge(charge, {
      signal: new AbortController().signal,
    });

    await jest.advanceTimersByTimeAsync(1000);

    await expect(result).resolves.toEqual({
      outcome: "declined",
      reason: DECLINE_REASONS[1],
    });
  });

  it("hangs until the signal aborts", async () => {
    const controller = new AbortController();
    const settled = jest.fn();
    const result = gateway(0.01)
      .charge(charge, { signal: controller.signal })
      .catch((err: unknown) => {
        settled();
        throw err;
      });

    await jest.advanceTimersByTimeAsync(60_000);
    expect(settled).not.toHaveBeenCalled();
    controller.abort();

    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(jest.getTimerCount()).toBe(0);
  });

  it("rejects when aborted during the delay and leaves no timer behind", async () => {
    const controller = new AbortController();
    const result = gateway(0.5, 0.5).charge(charge, {
      signal: controller.signal,
    });
    await jest.advanceTimersByTimeAsync(500);
    expect(jest.getTimerCount()).toBe(1);

    controller.abort();

    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(jest.getTimerCount()).toBe(0);
  });

  it("rejects at once when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      gateway(0.5, 0.5).charge(charge, { signal: controller.signal })
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(jest.getTimerCount()).toBe(0);
  });
});
