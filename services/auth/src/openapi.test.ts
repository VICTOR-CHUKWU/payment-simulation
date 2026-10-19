import { findOpenApiIssues, type OperationAccess } from "@payment-be/shared";
import {
  accessTokenEnvelopeSchema,
  loginBodySchema,
  registerBodySchema,
  userEnvelopeSchema,
} from "./auth/index.js";
import { buildDocument } from "./openapi.js";

const OPERATIONS: Record<string, OperationAccess> = {
  "GET /health/live": "public",
  "GET /health/ready": "public",
  "POST /auth/login": "public",
  "POST /auth/register": "public",
};

describe("auth OpenAPI document", () => {
  it("documents every operation completely", () => {
    expect(findOpenApiIssues(buildDocument(), OPERATIONS)).toEqual([]);
  });

  it("has a description", () => {
    expect(buildDocument().info.description).toEqual(expect.any(String));
  });

  it.each([
    accessTokenEnvelopeSchema,
    loginBodySchema,
    registerBodySchema,
    userEnvelopeSchema,
  ])("has an example that matches its schema", (schema) => {
    const example = schema.meta()?.example;
    expect(example).toBeDefined();
    expect(schema.safeParse(example).error).toBeUndefined();
  });
});
