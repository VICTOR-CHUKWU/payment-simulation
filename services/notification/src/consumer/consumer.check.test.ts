import { consumersCheck } from "./consumer.check.js";

const consumer = (running: boolean) => ({ running: () => running });

describe("consumersCheck", () => {
  it("is named consumers", () => {
    expect(consumersCheck([]).name).toBe("consumers");
  });

  it("passes when every consumer is running", () => {
    expect(consumersCheck([consumer(true), consumer(true)]).check()).toBe(true);
  });

  it.each([
    [false, true],
    [true, false],
  ])("fails when a consumer has stopped (%s, %s)", (a, b) => {
    expect(consumersCheck([consumer(a), consumer(b)]).check()).toBe(false);
  });
});
