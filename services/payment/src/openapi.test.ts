import { findOpenApiIssues, type OperationAccess } from "@payment-be/shared";
import { buildDocument } from "./openapi.js";
import {
  createPaymentBodySchema,
  paymentEnvelopeSchema,
  updatePaymentStatusBodySchema,
} from "./payment/index.js";

const OPERATIONS: Record<string, OperationAccess> = {
  "GET /health/live": "public",
  "GET /health/ready": "public",
  "GET /payments/{id}": "bearer",
  "PATCH /payments/{id}/status": "admin",
  "POST /payments": "bearer",
};

describe("payment OpenAPI document", () => {
  it("documents every operation completely", () => {
    expect(findOpenApiIssues(buildDocument(), OPERATIONS)).toEqual([]);
  });

  it("has a description", () => {
    expect(buildDocument().info.description).toEqual(expect.any(String));
  });

  it.each([
    createPaymentBodySchema,
    paymentEnvelopeSchema,
    updatePaymentStatusBodySchema,
  ])("has an example that matches its schema", (schema) => {
    const example = schema.meta()?.example;
    expect(example).toBeDefined();
    expect(schema.safeParse(example).error).toBeUndefined();
  });
});
