import express from "express";
import request from "supertest";
import { z } from "zod";
import { problemDetailsSchema } from "./errors.js";
import {
  bearerSecurity,
  buildOpenApiDocument,
  createOpenApiRegistry,
  docsRouter,
  findOpenApiIssues,
  type OpenAPIRegistry,
  problemResponses,
} from "./openapi.js";

const PROBLEM_REF = { $ref: "#/components/schemas/ProblemDetails" };
const HTML = /^text\/html/;
const JSON_TYPE = /^application\/json/;

const info = { title: "test service", version: "1.0.0" };

describe("buildOpenApiDocument", () => {
  const document = buildOpenApiDocument(createOpenApiRegistry(), info);

  it("generates an OpenAPI 3.1 document with a relative server", () => {
    expect(document.openapi).toBe("3.1.0");
    expect(document.info).toEqual(info);
    expect(document.servers).toEqual([{ url: "/" }]);
  });

  it("declares the bearerAuth scheme", () => {
    expect(document.components?.securitySchemes?.bearerAuth).toEqual({
      bearerFormat: "JWT",
      description: expect.stringContaining("POST /auth/login"),
      scheme: "bearer",
      type: "http",
    });
  });

  it("emits ProblemDetails before any route references it", () => {
    expect(document.components?.schemas?.ProblemDetails).toMatchObject({
      type: "object",
    });
  });

  it("documents the health endpoints without security", () => {
    const live = document.paths?.["/health/live"]?.get;
    const ready = document.paths?.["/health/ready"]?.get;
    expect(Object.keys(live?.responses ?? {})).toEqual(["200"]);
    expect(Object.keys(ready?.responses ?? {})).toEqual(["200", "503"]);
    expect(live?.security).toBeUndefined();
    expect(ready?.security).toBeUndefined();
    expect(live?.tags).toEqual(["health"]);
    expect(ready?.tags).toEqual(["health"]);
  });

  it("keeps registries independent", () => {
    const first = createOpenApiRegistry();
    first.registerPath({
      method: "get",
      path: "/only-here",
      responses: { 204: { description: "No Content" } },
    });
    const other = buildOpenApiDocument(createOpenApiRegistry(), info);
    expect(buildOpenApiDocument(first, info).paths).toHaveProperty(
      "/only-here"
    );
    expect(other.paths).not.toHaveProperty("/only-here");
  });
});

describe("problemResponses", () => {
  it("maps each status to a problem+json response", () => {
    const registry = createOpenApiRegistry();
    registry.registerPath({
      method: "get",
      path: "/thing",
      responses: problemResponses(401, 404),
    });
    const responses = buildOpenApiDocument(registry, info).paths?.["/thing"]
      ?.get?.responses;
    const problem = (status: number, title: string, code: string) => ({
      content: {
        "application/problem+json": {
          example: expect.objectContaining({ code, status, title }),
          schema: PROBLEM_REF,
        },
      },
      description: title,
    });
    expect(responses).toEqual({
      401: problem(401, "Unauthorized", "unauthorized"),
      404: problem(404, "Not Found", "not-found"),
    });
  });

  it("gives each problem example a body that matches the schema", () => {
    const registry = createOpenApiRegistry();
    registry.registerPath({
      method: "get",
      path: "/thing",
      responses: problemResponses(422),
    });
    const content = buildOpenApiDocument(registry, info).paths?.["/thing"]?.get
      ?.responses?.["422"]?.content;
    expect(
      problemDetailsSchema.parse(content?.["application/problem+json"]?.example)
    ).toMatchObject({ code: "unprocessable-entity", status: 422 });
  });

  it("documents a protected route with bearerSecurity", () => {
    const registry = createOpenApiRegistry();
    registry.registerPath({
      method: "get",
      path: "/me",
      responses: {
        200: {
          content: {
            "application/json": { schema: z.object({ id: z.string() }) },
          },
          description: "OK",
        },
        ...problemResponses(401),
      },
      security: bearerSecurity,
    });
    const route = buildOpenApiDocument(registry, info).paths?.["/me"]?.get;
    expect(route?.security).toEqual([{ bearerAuth: [] }]);
    expect(Object.keys(route?.responses ?? {})).toEqual(["200", "401"]);
  });
});

describe("docsRouter", () => {
  const docsApp = (title: string) =>
    express().use(
      docsRouter(
        buildOpenApiDocument(createOpenApiRegistry(), { ...info, title })
      )
    );

  it("serves the document as JSON", async () => {
    const res = await request(docsApp("json service")).get(
      "/docs/openapi.json"
    );
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(JSON_TYPE);
    expect(res.body.info.title).toBe("json service");
  });

  it("redirects /docs to /docs/", async () => {
    const res = await request(docsApp("redirect")).get("/docs");
    expect(res.status).toBe(301);
    expect(res.headers.location).toBe("/docs/");
  });

  it("serves Swagger UI", async () => {
    const res = await request(docsApp("ui")).get("/docs/");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(HTML);
    expect(res.text).toContain("swagger-ui");
  });

  it("passes the Swagger UI options to the browser", async () => {
    const res = await request(docsApp("options")).get(
      "/docs/swagger-ui-init.js"
    );
    expect(res.status).toBe(200);
    expect(res.text).toContain('"displayRequestDuration": true');
    expect(res.text).toContain('"persistAuthorization": true');
    expect(res.text).toContain('"tryItOutEnabled": true');
  });

  it("keeps each app's document separate", async () => {
    const first = docsApp("first service");
    const second = docsApp("second service");
    const [a, b] = await Promise.all([
      request(first).get("/docs/swagger-ui-init.js"),
      request(second).get("/docs/swagger-ui-init.js"),
    ]);
    expect(a.text).toContain("first service");
    expect(a.text).not.toContain("second service");
    expect(b.text).toContain("second service");
  });
});

describe("findOpenApiIssues", () => {
  const body = z
    .object({ name: z.string() })
    .meta({ example: { name: "x" }, id: "LintBody" });
  const reply = z
    .object({ ok: z.boolean() })
    .meta({ example: { ok: true }, id: "LintReply" });
  const bare = z.object({ ok: z.boolean() }).meta({ id: "LintBare" });

  const complete = (registry: OpenAPIRegistry, path: string) =>
    registry.registerPath({
      description: "Does the thing.",
      method: "post",
      path,
      request: { body: { content: { "application/json": { schema: body } } } },
      responses: {
        200: {
          content: { "application/json": { schema: reply } },
          description: "ok",
        },
        ...problemResponses(400, 401, 403, 500),
      },
      security: bearerSecurity,
      summary: "Do",
      tags: ["lint"],
    });

  const health = {
    "GET /health/live": "public",
    "GET /health/ready": "public",
  } as const;

  it("finds nothing wrong with a complete document", () => {
    const registry = createOpenApiRegistry();
    complete(registry, "/things");
    const document = buildOpenApiDocument(registry, {
      title: "t",
      version: "1",
    });
    expect(
      findOpenApiIssues(document, { ...health, "POST /things": "admin" })
    ).toEqual([]);
  });

  it("reports each broken rule and unlisted or missing operations", () => {
    const registry = createOpenApiRegistry();
    registry.registerPath({
      method: "post",
      path: "/broken",
      request: {
        body: {
          content: {
            "application/json": { schema: z.object({ a: z.string() }) },
          },
        },
      },
      responses: {
        200: {
          content: { "application/json": { schema: bare } },
          description: "ok",
        },
        404: {
          content: { "application/json": { schema: bare } },
          description: "x",
        },
      },
    });
    complete(registry, "/extra");
    const document = buildOpenApiDocument(registry, {
      title: "t",
      version: "1",
    });
    expect(
      findOpenApiIssues(document, {
        ...health,
        "GET /missing": "public",
        "POST /broken": "admin",
      })
    ).toEqual([
      "POST /broken: no summary",
      "POST /broken: no description",
      "POST /broken: no tag",
      "POST /broken: request body has no example",
      "POST /broken: 200 response has no example",
      "POST /broken: 404 response is not problem+json",
      "POST /broken: does not document 500",
      "POST /broken: missing bearer security",
      "POST /broken: does not document 401",
      "POST /broken: does not document 403",
      "POST /extra: not in the expected operations",
      "GET /missing: expected but not documented",
    ]);
  });

  it("reports security on a public operation", () => {
    const registry = createOpenApiRegistry();
    complete(registry, "/open");
    const document = buildOpenApiDocument(registry, {
      title: "t",
      version: "1",
    });
    expect(
      findOpenApiIssues(document, { ...health, "POST /open": "public" })
    ).toEqual(["POST /open: public operation has security"]);
  });
});
