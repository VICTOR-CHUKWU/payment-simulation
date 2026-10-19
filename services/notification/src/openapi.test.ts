import { findOpenApiIssues, type OperationAccess } from "@payment-be/shared";
import {
  dlqEntryEnvelopeSchema,
  dlqPageSchema,
  replayEnvelopeSchema,
} from "./dlq/index.js";
import {
  markAllReadEnvelopeSchema,
  notificationEnvelopeSchema,
  notificationPageSchema,
} from "./notification/index.js";
import { buildDocument } from "./openapi.js";

const OPERATIONS: Record<string, OperationAccess> = {
  "GET /admin/dlq": "admin",
  "GET /admin/dlq/{seq}": "admin",
  "GET /health/live": "public",
  "GET /health/ready": "public",
  "GET /notifications": "bearer",
  "PATCH /notifications/{id}/read": "bearer",
  "PATCH /notifications/read": "bearer",
  "POST /admin/dlq/{seq}/replay": "admin",
};

describe("notification OpenAPI document", () => {
  it("documents every operation completely", () => {
    expect(findOpenApiIssues(buildDocument(), OPERATIONS)).toEqual([]);
  });

  it("has a description", () => {
    expect(buildDocument().info.description).toEqual(expect.any(String));
  });

  it.each([
    dlqEntryEnvelopeSchema,
    dlqPageSchema,
    markAllReadEnvelopeSchema,
    notificationEnvelopeSchema,
    notificationPageSchema,
    replayEnvelopeSchema,
  ])("has an example that matches its schema", (schema) => {
    const example = schema.meta()?.example;
    expect(example).toBeDefined();
    expect(schema.safeParse(example).error).toBeUndefined();
  });
});
