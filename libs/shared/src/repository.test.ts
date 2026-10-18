import { Writable } from "node:stream";
import express from "express";
import request from "supertest";
import { AppError, errorHandler } from "./errors.js";
import { createLogger, httpLogger } from "./logger.js";
import { createMemoryRepository } from "./memory-repository.js";
import {
  DuplicateRecordError,
  RecordNotFoundError,
  type Repository,
  VersionConflictError,
  type Versioned,
} from "./repository.js";

interface Item extends Versioned {
  name: string;
  note?: string;
  tags: string[];
}

type Shape = Versioned &
  ({ kind: "circle"; radius: number } | { kind: "square"; side: number });

type AdapterFactory = () => Repository<Item> | Promise<Repository<Item>>;

const adapters: [string, AdapterFactory][] = [
  ["memory", createMemoryRepository],
];

const PROBLEM_JSON = /^application\/problem\+json/;
const ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";

const newItem = (id = ID) => ({ id, name: "first", tags: ["a"] });

describe.each(adapters)("%s", (_name, createRepository) => {
  let repo: Repository<Item>;

  beforeEach(async () => {
    repo = await createRepository();
  });

  it("inserts a record at version 1 and gets it back", async () => {
    const inserted = await repo.insert(newItem());

    expect(inserted).toEqual({ ...newItem(), version: 1 });
    expect(await repo.get(ID)).toEqual(inserted);
  });

  it("returns undefined for an unknown ID", async () => {
    expect(await repo.get(ID)).toBeUndefined();
  });

  it("rejects a duplicate ID and keeps the original", async () => {
    await repo.insert(newItem());

    await expect(
      repo.insert({ ...newItem(), name: "second" })
    ).rejects.toBeInstanceOf(DuplicateRecordError);
    expect((await repo.get(ID))?.name).toBe("first");
  });

  it("finds records in insertion order and filters by predicate", async () => {
    expect(await repo.find()).toEqual([]);
    await repo.insert(newItem(OTHER_ID));
    await repo.insert({ ...newItem(), name: "second" });

    expect((await repo.find()).map((item) => item.id)).toEqual([OTHER_ID, ID]);
    expect(
      (await repo.find((item) => item.name === "second")).map((item) => item.id)
    ).toEqual([ID]);
  });

  it("rejects instead of throwing when the predicate throws", async () => {
    await repo.insert(newItem());
    const failure = new Error("predicate failed");
    const pending = Promise.allSettled([
      repo.find(() => {
        throw failure;
      }),
    ]);

    expect(await pending).toEqual([{ reason: failure, status: "rejected" }]);
  });

  it("keeps insertion order after an update", async () => {
    await repo.insert(newItem());
    await repo.insert(newItem(OTHER_ID));
    await repo.update(ID, 1, { name: "renamed" });

    expect((await repo.find()).map((item) => item.id)).toEqual([ID, OTHER_ID]);
  });

  it("merges a patch at the current version and bumps the version", async () => {
    await repo.insert(newItem());
    const updated = await repo.update(ID, 1, { name: "renamed" });

    expect(updated).toEqual({ ...newItem(), name: "renamed", version: 2 });
    expect(await repo.get(ID)).toEqual(updated);
  });

  it("rejects a stale version and leaves the record unchanged", async () => {
    await repo.insert(newItem());
    await repo.update(ID, 1, { name: "renamed" });

    await expect(repo.update(ID, 1, { name: "stale" })).rejects.toBeInstanceOf(
      VersionConflictError
    );
    expect(await repo.get(ID)).toEqual({
      ...newItem(),
      name: "renamed",
      version: 2,
    });
  });

  it("lets exactly one of two concurrent updates win", async () => {
    await repo.insert(newItem());
    const results = await Promise.allSettled([
      repo.update(ID, 1, { name: "left" }),
      repo.update(ID, 1, { name: "right" }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(VersionConflictError);
    expect((await repo.get(ID))?.version).toBe(2);
  });

  it("rejects an update of an unknown ID", async () => {
    await expect(
      repo.update(ID, 1, { name: "missing" })
    ).rejects.toBeInstanceOf(RecordNotFoundError);
  });

  it("ignores id and version smuggled into a patch", async () => {
    await repo.insert(newItem());
    const patch = { id: OTHER_ID, name: "renamed", version: 99 } as {
      name: string;
    };
    const updated = await repo.update(ID, 1, patch);

    expect(updated.id).toBe(ID);
    expect(updated.version).toBe(2);
    expect(await repo.get(ID)).toEqual(updated);
    expect(await repo.get(OTHER_ID)).toBeUndefined();
  });

  it("skips patch keys set to undefined", async () => {
    await repo.insert({ ...newItem(), note: "keep" });
    const updated = await repo.update(ID, 1, {
      name: "renamed",
      note: undefined,
    });

    expect(updated.note).toBe("keep");
    expect(Object.hasOwn(updated, "note")).toBe(true);
  });

  it("never shares objects with callers", async () => {
    const input = newItem();
    const inserted = await repo.insert(input);
    input.tags.push("from-input");
    inserted.tags.push("from-insert");

    const patch = { tags: ["b"] };
    const updated = await repo.update(ID, 1, patch);
    patch.tags.push("from-patch");
    updated.tags.push("from-update");

    const fetched = await repo.get(ID);
    fetched?.tags.push("from-get");
    const [found] = await repo.find();
    found?.tags.push("from-find");
    await repo.find((item) => {
      item.tags.push("from-predicate");
      return true;
    });

    expect((await repo.get(ID))?.tags).toEqual(["b"]);
  });
});

describe("discriminated union records", () => {
  it("keeps member-specific fields on insert and update", async () => {
    const repo = createMemoryRepository<Shape>();
    await repo.insert({ id: ID, kind: "circle", radius: 1 });
    const updated = await repo.update(ID, 1, { radius: 2 });

    expect(updated).toEqual({ id: ID, kind: "circle", radius: 2, version: 2 });
  });
});

describe("repository errors", () => {
  function setup() {
    const destination = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    const logger = createLogger({
      destination,
      level: "info",
      pretty: false,
      service: "test",
    });
    const app = express();
    app.use(httpLogger(logger));
    app.get("/conflict", () => {
      throw new VersionConflictError({ id: ID });
    });
    app.get("/missing", () => {
      throw new RecordNotFoundError({ id: ID });
    });
    app.get("/duplicate", () => {
      throw new DuplicateRecordError({ id: ID });
    });
    app.use(errorHandler);
    return app;
  }

  it("carries name, id and the right base class", () => {
    const conflictError = new VersionConflictError({ id: ID });
    const missingError = new RecordNotFoundError({ id: ID });
    const duplicateError = new DuplicateRecordError({ id: ID });

    expect(conflictError).toBeInstanceOf(AppError);
    expect(conflictError.name).toBe("VersionConflictError");
    expect(conflictError.id).toBe(ID);
    expect(conflictError.message).toContain(ID);
    expect(missingError).toBeInstanceOf(AppError);
    expect(missingError.name).toBe("RecordNotFoundError");
    expect(missingError.id).toBe(ID);
    expect(missingError.message).toContain(ID);
    expect(duplicateError).not.toBeInstanceOf(AppError);
    expect(duplicateError.name).toBe("DuplicateRecordError");
    expect(duplicateError.id).toBe(ID);
  });

  it("maps a version conflict to 409 version-conflict", async () => {
    const response = await request(setup()).get("/conflict");

    expect(response.status).toBe(409);
    expect(response.headers["content-type"]).toMatch(PROBLEM_JSON);
    expect(response.body).toMatchObject({
      code: "version-conflict",
      status: 409,
      title: "Version conflict",
      type: "tag:payment-be,2026:version-conflict",
    });
    expect(JSON.stringify(response.body)).not.toContain(ID);
  });

  it("maps a missing record to 404 not-found", async () => {
    const response = await request(setup()).get("/missing");

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({
      code: "not-found",
      title: "Not Found",
      type: "about:blank",
    });
    expect(JSON.stringify(response.body)).not.toContain(ID);
  });

  it("maps a duplicate record to 500 internal-error", async () => {
    const response = await request(setup()).get("/duplicate");

    expect(response.status).toBe(500);
    expect(response.body).toMatchObject({ code: "internal-error" });
    expect(JSON.stringify(response.body)).not.toContain(ID);
  });
});
