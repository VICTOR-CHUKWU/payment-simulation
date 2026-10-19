import { isPermanent, retryDelay } from "./email.retry.js";
import { EmailSendError } from "./email.service.js";

const DEFAULTS = [5000, 30_000, 120_000, 600_000];

describe("retryDelay", () => {
  it.each([
    [1, 5000],
    [2, 30_000],
    [3, 120_000],
    [4, 600_000],
  ])("waits the configured delay after attempt %i", (attempt, delay) => {
    expect(retryDelay(attempt, DEFAULTS)).toBe(delay);
  });

  it("repeats the last delay for a short list", () => {
    expect(retryDelay(1, [1000, 2000])).toBe(1000);
    expect(retryDelay(2, [1000, 2000])).toBe(2000);
    expect(retryDelay(5, [1000, 2000])).toBe(2000);
  });
});

describe("isPermanent", () => {
  it.each([
    [{ responseCode: 550 }],
    [{ responseCode: 554 }],
    [{ code: "EENVELOPE" }],
    [{ code: "EENVELOPE", responseCode: 550 }],
  ])("is true for %o", (fields) => {
    expect(isPermanent(new EmailSendError(fields))).toBe(true);
  });

  it.each([
    [{ responseCode: 421 }],
    [{ responseCode: 451 }],
    [{ code: "EENVELOPE", responseCode: 451 }],
    [{ code: "ESOCKET" }],
    [{ code: "ETIMEDOUT" }],
    [{}],
  ])("is false for %o", (fields) => {
    expect(isPermanent(new EmailSendError(fields))).toBe(false);
  });
});
