import express from "express";
import request from "supertest";
import { z } from "zod";
import {
  dataResponseSchema,
  pageResponseSchema,
  sendData,
  sendPage,
} from "./response.js";

const meta = { limit: 2, page: 1, total: 3, totalPages: 2 };

function app() {
  const server = express();
  server.get("/default", (_req, res) => {
    sendData(res, { id: "a" });
  });
  server.get("/created", (_req, res) => {
    sendData(res, { id: "a" }, { message: "Created", status: 201 });
  });
  server.get("/page", (_req, res) => {
    sendPage(res, [{ id: "a" }, { id: "b" }], meta);
  });
  return server;
}

describe("sendData", () => {
  it("wraps the payload with status 200 and a null message by default", async () => {
    const res = await request(app()).get("/default");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: { id: "a" },
      message: null,
      status: 200,
      success: true,
    });
  });

  it("uses the given status and message in both the response and the body", async () => {
    const res = await request(app()).get("/created");
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      data: { id: "a" },
      message: "Created",
      status: 201,
      success: true,
    });
  });
});

describe("sendPage", () => {
  it("sends an array of items with meta", async () => {
    const res = await request(app()).get("/page");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: [{ id: "a" }, { id: "b" }],
      message: null,
      meta,
      status: 200,
      success: true,
    });
  });
});

describe("response schemas", () => {
  const item = z.object({ id: z.string() });

  it("accepts a data envelope and rejects a failed or mistyped one", () => {
    const schema = dataResponseSchema(item);
    const body = {
      data: { id: "a" },
      message: null,
      status: 200,
      success: true,
    };
    expect(schema.safeParse(body).success).toBe(true);
    expect(schema.safeParse({ ...body, success: false }).success).toBe(false);
    expect(schema.safeParse({ ...body, data: { id: 1 } }).success).toBe(false);
  });

  it("accepts a page envelope and requires meta", () => {
    const schema = pageResponseSchema(item);
    const body = {
      data: [{ id: "a" }],
      message: "ok",
      meta,
      status: 200,
      success: true,
    };
    expect(schema.safeParse(body).success).toBe(true);
    const { meta: _meta, ...withoutMeta } = body;
    expect(schema.safeParse(withoutMeta).success).toBe(false);
  });
});
