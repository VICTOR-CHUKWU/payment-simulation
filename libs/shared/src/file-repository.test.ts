import { spawn } from "node:child_process";
import {
  type FileHandle,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import {
  createFileRepository,
  type FileRepository,
  type FileSystem,
  storageCheck,
} from "./file-repository.js";
import { createLogger } from "./logger.js";
import { VersionConflictError } from "./repository.js";

interface Item {
  id: string;
  name: string;
  version: number;
}

type Fault =
  | "temp-open"
  | "temp-write"
  | "temp-sync"
  | "rename"
  | "dir-open"
  | "dir-sync-einval"
  | "dir-sync-eio";

const itemSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.number().int(),
});

const ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const TEMP_FILE = /^\.items\.json\..+\.tmp$/;

const closers: (() => Promise<void>)[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "payment-be-repo-"));
  tempDirs.push(dir);
  return dir;
}

function injected(code: string): Error {
  return Object.assign(new Error(`injected ${code}`), { code });
}

function wrapHandle(
  handle: FileHandle,
  overrides: Partial<Pick<FileHandle, "sync" | "writeFile">>
): FileHandle {
  return {
    close: () => handle.close(),
    sync: () => handle.sync(),
    writeFile: (data: string) => handle.writeFile(data),
    ...overrides,
  } as unknown as FileHandle;
}

function faultyFs() {
  const control: { fault?: Fault; beforeRename?: Promise<void> } = {};

  const faultyOpen = (async (
    file: string,
    flags: string,
    mode?: number
  ): Promise<FileHandle> => {
    const isTemp = flags === "wx";
    if (control.fault === (isTemp ? "temp-open" : "dir-open")) {
      throw injected("EIO");
    }
    const handle = await open(file, flags, mode);
    if (isTemp && control.fault === "temp-write") {
      return wrapHandle(handle, {
        writeFile: () => Promise.reject(injected("ENOSPC")),
      });
    }
    if (isTemp && control.fault === "temp-sync") {
      return wrapHandle(handle, {
        sync: () => Promise.reject(injected("EIO")),
      });
    }
    if (!isTemp && control.fault === "dir-sync-einval") {
      return wrapHandle(handle, {
        sync: () => Promise.reject(injected("EINVAL")),
      });
    }
    if (!isTemp && control.fault === "dir-sync-eio") {
      return wrapHandle(handle, {
        sync: () => Promise.reject(injected("EIO")),
      });
    }
    return handle;
  }) as typeof open;

  const faultyRename = (async (from: string, to: string) => {
    await control.beforeRename;
    if (control.fault === "rename") {
      throw injected("EXDEV");
    }
    await rename(from, to);
  }) as typeof rename;

  const fs: FileSystem = {
    mkdir,
    open: faultyOpen,
    readdir,
    readFile,
    rename: faultyRename,
    unlink,
    writeFile,
  };
  return { control, fs };
}

function capture() {
  const lines: Record<string, unknown>[] = [];
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      for (const line of chunk.toString().split("\n").filter(Boolean)) {
        lines.push(JSON.parse(line) as Record<string, unknown>);
      }
      callback();
    },
  });
  const logger = createLogger({
    destination,
    level: "info",
    pretty: false,
    service: "test",
  });
  return { lines, logger };
}

async function openItems(
  file: string,
  options: {
    fs?: FileSystem;
    logger?: ReturnType<typeof capture>["logger"];
  } = {}
): Promise<FileRepository<Item>> {
  const repository = await createFileRepository({
    file,
    schema: itemSchema,
    ...options,
  });
  closers.push(repository.close);
  return repository;
}

async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((resolve) => child.once("exit", resolve));
  if (child.pid === undefined) {
    throw new Error("child process did not start");
  }
  return child.pid;
}

describe("createFileRepository", () => {
  it("keeps records, versions and order across a reopen", async () => {
    const file = path.join(await tempDir(), "items.json");
    const first = await openItems(file);
    await first.insert({ id: OTHER_ID, name: "second" });
    await first.insert({ id: ID, name: "first" });
    await first.update(OTHER_ID, 1, { name: "renamed" });
    await first.close();

    const reopened = await openItems(file);
    expect(await reopened.find()).toEqual([
      { id: OTHER_ID, name: "renamed", version: 2 },
      { id: ID, name: "first", version: 1 },
    ]);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      formatVersion: 1,
      records: [
        { id: OTHER_ID, name: "renamed", version: 2 },
        { id: ID, name: "first", version: 1 },
      ],
    });
    expect((await stat(file)).mode % 0o1000).toBe(0o600);
  });

  it("persists every one of 20 concurrent inserts", async () => {
    const file = path.join(await tempDir(), "items.json");
    const repo = await openItems(file);
    const ids = Array.from(
      { length: 20 },
      (_, i) => `id-${String(i).padStart(2, "0")}`
    );

    await Promise.all(ids.map((id) => repo.insert({ id, name: id })));
    await repo.close();

    const reopened = await openItems(file);
    expect((await reopened.find()).map((item) => item.id).sort()).toEqual(ids);
  });

  it("writes only the winner of two concurrent updates", async () => {
    const file = path.join(await tempDir(), "items.json");
    const repo = await openItems(file);
    await repo.insert({ id: ID, name: "first" });

    const results = await Promise.allSettled([
      repo.update(ID, 1, { name: "left" }),
      repo.update(ID, 1, { name: "right" }),
    ]);

    const winner = results.find((r) => r.status === "fulfilled");
    const loser = results.find((r) => r.status === "rejected");
    expect(loser?.reason).toBeInstanceOf(VersionConflictError);
    const saved = JSON.parse(await readFile(file, "utf8"));
    expect(saved.records).toEqual([winner?.value]);
  });

  it.each<Fault>(["temp-open", "temp-write", "temp-sync", "rename"])(
    "rolls back when %s fails",
    async (fault) => {
      const dir = await tempDir();
      const file = path.join(dir, "items.json");
      const { control, fs } = faultyFs();
      const repo = await openItems(file, { fs });
      await repo.insert({ id: ID, name: "first" });
      const before = await readFile(file, "utf8");

      control.fault = fault;
      const failed = repo.update(ID, 1, { name: "lost" });
      const queued = repo.update(ID, 1, { name: "queued" });
      await expect(failed).rejects.toThrow("injected");
      await expect(queued).rejects.toThrow("injected");

      expect(await repo.get(ID)).toEqual({ id: ID, name: "first", version: 1 });
      expect(await readFile(file, "utf8")).toBe(before);
      expect(
        (await readdir(dir)).filter((name) => TEMP_FILE.test(name))
      ).toEqual([]);
      expect(repo.isHealthy()).toBe(false);

      control.fault = undefined;
      await repo.update(ID, 1, { name: "saved" });
      expect(repo.isHealthy()).toBe(true);
    }
  );

  it("ignores a directory sync the filesystem does not support", async () => {
    const file = path.join(await tempDir(), "items.json");
    const { control, fs } = faultyFs();
    const repo = await openItems(file, { fs });
    control.fault = "dir-sync-einval";

    await repo.insert({ id: ID, name: "first" });
    expect(repo.isHealthy()).toBe(true);
  });

  it.each<Fault>(["dir-open", "dir-sync-eio"])(
    "keeps a renamed write when %s fails afterwards",
    async (fault) => {
      const file = path.join(await tempDir(), "items.json");
      const { control, fs } = faultyFs();
      const { lines, logger } = capture();
      const repo = await openItems(file, { fs, logger });
      await repo.insert({ id: ID, name: "first" });
      control.fault = fault;

      const updated = await repo.update(ID, 1, { name: "kept" });

      expect(updated).toEqual({ id: ID, name: "kept", version: 2 });
      expect(await repo.get(ID)).toEqual(updated);
      expect(repo.isHealthy()).toBe(false);
      expect(lines.some((line) => line.level === 50)).toBe(true);
      expect(JSON.stringify(lines)).not.toContain("kept");
      expect(JSON.parse(await readFile(file, "utf8")).records).toEqual([
        updated,
      ]);

      control.fault = undefined;
      await repo.update(ID, 2, { name: "again" });
      expect(repo.isHealthy()).toBe(true);
      await repo.close();
      const reopened = await openItems(file);
      expect((await reopened.get(ID))?.version).toBe(3);
    }
  );

  it("opens a missing file empty without writing it", async () => {
    const dir = path.join(await tempDir(), "nested", "data");
    const repo = await openItems(path.join(dir, "items.json"));

    expect(await repo.find()).toEqual([]);
    expect(await readdir(dir)).toEqual(["items.json.lock"]);
  });

  it.each([
    ["invalid JSON", '{"records": [nope'],
    [
      "a wrong format version",
      JSON.stringify({ formatVersion: 2, records: [] }),
    ],
    [
      "a record failing the schema",
      JSON.stringify({ formatVersion: 1, records: [{ id: ID, version: 1 }] }),
    ],
    [
      "duplicate IDs",
      JSON.stringify({
        formatVersion: 1,
        records: [
          { id: ID, name: "a", version: 1 },
          { id: ID, name: "b", version: 1 },
        ],
      }),
    ],
  ])("refuses to open a file with %s", async (_case, content) => {
    const dir = await tempDir();
    const file = path.join(dir, "items.json");
    await writeFile(file, content);

    const opening = createFileRepository({ file, schema: itemSchema });

    await expect(opening).rejects.toThrow(file);
    await expect(opening).rejects.not.toThrow("nope");
    expect(await readFile(file, "utf8")).toBe(content);
    expect(await readdir(dir)).toEqual(["items.json"]);
  });

  it("removes leftover temp files and keeps unrelated files", async () => {
    const dir = await tempDir();
    const leftover = ".items.json.123.abcdef.tmp";
    await writeFile(path.join(dir, leftover), "partial");
    await writeFile(path.join(dir, ".other.json.123.abcdef.tmp"), "keep");
    await writeFile(path.join(dir, ".items.json.bak.123.abcdef.tmp"), "keep");
    await writeFile(path.join(dir, "notes.txt"), "keep");

    await openItems(path.join(dir, "items.json"));

    expect((await readdir(dir)).sort()).toEqual([
      ".items.json.bak.123.abcdef.tmp",
      ".other.json.123.abcdef.tmp",
      "items.json.lock",
      "notes.txt",
    ]);
  });

  it("allows one open repository per file in a process", async () => {
    const file = path.join(await tempDir(), "items.json");
    const repo = await openItems(file);

    await expect(
      createFileRepository({ file, schema: itemSchema })
    ).rejects.toThrow("already open");

    await repo.close();
    await expect(openItems(file)).resolves.toBeDefined();
  });

  it("refuses a lock held by a live process", async () => {
    const file = path.join(await tempDir(), "items.json");
    await writeFile(`${file}.lock`, `${process.ppid}\n`);

    await expect(
      createFileRepository({ file, schema: itemSchema })
    ).rejects.toThrow(String(process.ppid));
    expect(await readFile(`${file}.lock`, "utf8")).toBe(`${process.ppid}\n`);
  });

  it.each([
    ["an exited process", async () => String(await exitedPid())],
    ["garbage", () => Promise.resolve("not-a-pid")],
  ])("takes over a lock left by %s", async (_case, owner) => {
    const file = path.join(await tempDir(), "items.json");
    await writeFile(`${file}.lock`, `${await owner()}\n`);
    const { lines, logger } = capture();

    await openItems(file, { logger });

    expect(await readFile(`${file}.lock`, "utf8")).toBe(`${process.pid}\n`);
    expect(lines.some((line) => line.msg === "taking over a stale lock")).toBe(
      true
    );
  });

  it("waits for an in-flight write on close and rejects later calls", async () => {
    const file = path.join(await tempDir(), "items.json");
    const { control, fs } = faultyFs();
    const repo = await openItems(file, { fs });
    const { promise, resolve: release } = Promise.withResolvers<void>();
    control.beforeRename = promise;

    const pending = repo.insert({ id: ID, name: "first" });
    const closing = repo.close();
    const settled: string[] = [];
    pending.then(() => settled.push("insert"));
    closing.then(() => settled.push("close"));
    await expect(repo.get(ID)).rejects.toThrow("closed");
    await expect(repo.find()).rejects.toThrow("closed");
    await expect(repo.insert({ id: OTHER_ID, name: "x" })).rejects.toThrow(
      "closed"
    );
    await expect(repo.update(ID, 1, { name: "x" })).rejects.toThrow("closed");
    await delay(20);
    expect(settled).toEqual([]);
    expect(await readFile(`${file}.lock`, "utf8")).toBe(`${process.pid}\n`);
    release();

    await expect(pending).resolves.toEqual({
      id: ID,
      name: "first",
      version: 1,
    });
    await closing;
    expect(settled).toEqual(["insert", "close"]);
    await expect(stat(`${file}.lock`)).rejects.toThrow("ENOENT");
    expect(JSON.parse(await readFile(file, "utf8")).records).toHaveLength(1);
    expect(repo.close()).toBe(closing);
    expect(repo.isHealthy()).toBe(false);
  });
});

describe("createFileRepository errors", () => {
  const withFs = (overrides: Partial<FileSystem>): FileSystem => ({
    mkdir,
    open,
    readdir,
    readFile,
    rename,
    unlink,
    writeFile,
    ...overrides,
  });

  it("rethrows a read error other than a missing file", async () => {
    const file = path.join(await tempDir(), "items.json");
    const fs = withFs({
      readFile: ((target: string, encoding: BufferEncoding) =>
        target === file
          ? Promise.reject(injected("EACCES"))
          : readFile(target, encoding)) as typeof readFile,
    });
    await expect(
      createFileRepository({ file, fs, schema: itemSchema })
    ).rejects.toThrow("injected EACCES");
  });

  it("rethrows a lock error other than an existing lock", async () => {
    const file = path.join(await tempDir(), "items.json");
    const fs = withFs({
      writeFile: (() => Promise.reject(injected("EROFS"))) as typeof writeFile,
    });
    await expect(
      createFileRepository({ file, fs, schema: itemSchema })
    ).rejects.toThrow("injected EROFS");
  });

  it("refuses when another process takes a stale lock first", async () => {
    const file = path.join(await tempDir(), "items.json");
    const lock = `${file}.lock`;
    await writeFile(lock, "not-a-pid\n");
    let attempts = 0;
    const fs = withFs({
      writeFile: (async (
        target: string,
        data: string,
        options: Parameters<typeof writeFile>[2]
      ) => {
        if (target === lock) {
          attempts += 1;
          if (attempts === 2) {
            await writeFile(lock, `${process.ppid}\n`);
          }
        }
        return writeFile(target, data, options);
      }) as typeof writeFile,
    });
    await expect(
      createFileRepository({ file, fs, schema: itemSchema })
    ).rejects.toThrow(`locked by process ${process.ppid}`);
  });

  it("rethrows a failure to remove a stale lock", async () => {
    const file = path.join(await tempDir(), "items.json");
    await writeFile(`${file}.lock`, "not-a-pid\n");
    const fs = withFs({
      unlink: (() => Promise.reject(injected("EPERM"))) as typeof unlink,
    });
    await expect(
      createFileRepository({ file, fs, schema: itemSchema })
    ).rejects.toThrow("injected EPERM");
  });
});

describe("storageCheck", () => {
  it("reports the repository's health", async () => {
    const file = path.join(await tempDir(), "items.json");
    const { control, fs } = faultyFs();
    const repo = await openItems(file, { fs });
    const check = storageCheck(repo);

    expect(check.name).toBe("storage");
    expect(await check.check()).toBe(true);
    control.fault = "rename";
    await expect(repo.insert({ id: ID, name: "first" })).rejects.toThrow();
    expect(await check.check()).toBe(false);
  });
});
