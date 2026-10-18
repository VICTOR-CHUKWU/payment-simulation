import { SHARED_PACKAGE_NAME } from "./index.js";

describe("shared", () => {
  it("exports its package name", () => {
    expect(SHARED_PACKAGE_NAME).toBe("@payment-be/shared");
  });
});
