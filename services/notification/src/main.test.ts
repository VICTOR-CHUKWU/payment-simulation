import { SHARED_PACKAGE_NAME } from "@payment-be/shared";
import { SERVICE_NAME, SHARED_DEPENDENCY } from "./main.js";

describe("notification service", () => {
  it("resolves the shared lib", () => {
    expect(SERVICE_NAME).toBe("notification");
    expect(SHARED_DEPENDENCY).toBe(SHARED_PACKAGE_NAME);
  });
});
