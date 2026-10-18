import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { openRepository, storageConfigSchema } from "./storage.js";

const itemSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.number().int(),
});

const ID = "11111111-1111-4111-8111-111111111111";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "payment-be-repo-"));
});

afterEach(async () => {
  await rm(dir, { force: true, recursive: true });
});

describe("storageConfigSchema", () => {
  it("defaults to the file driver in ./data", () => {
    expect(storageConfigSchema.parse({})).toEqual({
      DATA_DIR: "data",
      STORAGE_DRIVER: "file",
    });
  });

  it("rejects an unknown driver", () => {
    expect(
      storageConfigSchema.safeParse({ STORAGE_DRIVER: "redis" }).success
    ).toBe(false);
  });
});

describe("openRepository", () => {
  it("opens a memory repository without touching the disk", async () => {
    const opened = await openRepository({
      config: { DATA_DIR: dir, STORAGE_DRIVER: "memory" },
      name: "items",
      schema: itemSchema,
    });

    await opened.repository.insert({ id: ID, name: "first" });
    expect(opened.check.name).toBe("storage");
    expect(await opened.check.check()).toBe(true);
    await opened.close();
    expect(await readdir(dir)).toEqual([]);
  });

  it("opens a file repository at DATA_DIR/<name>.json", async () => {
    const opened = await openRepository({
      config: { DATA_DIR: dir, STORAGE_DRIVER: "file" },
      name: "items",
      schema: itemSchema,
    });

    await opened.repository.insert({ id: ID, name: "first" });
    expect(opened.check.name).toBe("storage");
    expect(await opened.check.check()).toBe(true);
    expect((await readdir(dir)).sort()).toEqual([
      "items.json",
      "items.json.lock",
    ]);
    await opened.close();
    expect(await opened.check.check()).toBe(false);
    expect(await readdir(dir)).toEqual(["items.json"]);
  });

  it("rejects a name that is not a safe file name", async () => {
    await expect(
      openRepository({
        config: { DATA_DIR: dir, STORAGE_DRIVER: "file" },
        name: "../items",
        schema: itemSchema,
      })
    ).rejects.toThrow("Invalid repository name");
    expect(await readdir(dir)).toEqual([]);
  });
});
