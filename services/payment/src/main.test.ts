import { SHARED_PACKAGE_NAME } from "@payment-be/shared";
import { SERVICE_NAME, SHARED_DEPENDENCY } from "./main.js";

describe("payment service", () => {
  it("resolves the shared lib", () => {
    expect(SERVICE_NAME).toBe("payment");
    expect(SHARED_DEPENDENCY).toBe(SHARED_PACKAGE_NAME);
  });
});
