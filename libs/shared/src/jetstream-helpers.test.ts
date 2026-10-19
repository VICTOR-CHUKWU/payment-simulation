import { JetStreamApiError } from "@nats-io/jetstream";
import { isApiError, matchesConfig } from "./jetstream-helpers.js";

const apiError = (code: number) =>
  new JetStreamApiError({ code: 404, description: "test", err_code: code });

describe("isApiError", () => {
  it("matches a JetStream API error with the given code", () => {
    expect(isApiError(apiError(10_059), 10_059)).toBe(true);
  });

  it("rejects a JetStream API error with another code", () => {
    expect(isApiError(apiError(10_014), 10_059)).toBe(false);
  });

  it.each([
    ["a plain error", new Error("stream not found")],
    ["an object with the code", { code: 10_059 }],
    ["undefined", undefined],
  ])("rejects %s", (_label, err) => {
    expect(isApiError(err, 10_059)).toBe(false);
  });
});

describe("matchesConfig", () => {
  it("compares only the keys in the definition", () => {
    expect(
      matchesConfig<{ max_deliver: number; name: string; replicas: number }>(
        { max_deliver: -1, name: "A", replicas: 1 },
        { name: "A" }
      )
    ).toBe(true);
  });

  it("detects a differing value", () => {
    expect(matchesConfig({ name: "A" }, { name: "B" })).toBe(false);
  });

  it("detects a key the server lacks", () => {
    expect(
      matchesConfig<{ name: string; max_age?: number }>(
        { name: "A" },
        { max_age: 5, name: "A" }
      )
    ).toBe(false);
  });

  it("compares arrays element by element", () => {
    expect(
      matchesConfig({ subjects: ["a", "b"] }, { subjects: ["a", "b"] })
    ).toBe(true);
    expect(matchesConfig({ subjects: ["a", "b"] }, { subjects: ["a"] })).toBe(
      false
    );
    expect(
      matchesConfig({ subjects: ["a", "b"] }, { subjects: ["b", "a"] })
    ).toBe(false);
  });

  it("does not treat an array and a scalar as equal", () => {
    expect(
      matchesConfig<{ subjects: unknown }>(
        { subjects: "a" },
        { subjects: ["a"] }
      )
    ).toBe(false);
  });
});
