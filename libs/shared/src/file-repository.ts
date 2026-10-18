import { randomBytes } from "node:crypto";
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ReadinessCheck } from "./health.js";
import type { Logger } from "./logger.js";
import {
  DuplicateRecordError,
  RecordNotFoundError,
  type Repository,
  VersionConflictError,
  type Versioned,
} from "./repository.js";

export interface FileSystem {
  mkdir: typeof mkdir;
  open: typeof open;
  readdir: typeof readdir;
  readFile: typeof readFile;
  rename: typeof rename;
  unlink: typeof unlink;
  writeFile: typeof writeFile;
}

export interface FileRepositoryOptions<T extends Versioned> {
  file: string;
  fs?: FileSystem;
  logger?: Logger;
  schema: z.ZodType<T>;
}

export interface FileRepository<T extends Versioned> extends Repository<T> {
  close: () => Promise<void>;
  isHealthy: () => boolean;
}

const FORMAT_VERSION = 1;
const UNSUPPORTED_DIRECTORY_SYNC = new Set<unknown>([
  "EISDIR",
  "EINVAL",
  "EPERM",
]);
const TEMP_SUFFIX = /^\d+\.[0-9a-f]+\.tmp$/;

const nodeFs: FileSystem = {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  unlink,
  writeFile,
};

const openFiles = new Set<string>();

function errorCode(err: unknown): unknown {
  return typeof err === "object" && err !== null && "code" in err
    ? err.code
    : undefined;
}

async function ignoreMissing(operation: Promise<unknown>): Promise<void> {
  try {
    await operation;
  } catch (err) {
    if (errorCode(err) !== "ENOENT") {
      throw err;
    }
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return errorCode(err) !== "ESRCH";
  }
}

function isStaleOwner(owner: string): boolean {
  const pid = Number(owner);
  if (!Number.isInteger(pid) || pid <= 0) {
    return true;
  }
  return pid === process.pid || !isAlive(pid);
}

async function readOwner(fs: FileSystem, lockPath: string): Promise<string> {
  try {
    return (await fs.readFile(lockPath, "utf8")).trim();
  } catch (err) {
    if (errorCode(err) === "ENOENT") {
      return "";
    }
    throw err;
  }
}

async function acquireLock(
  fs: FileSystem,
  lockPath: string,
  logger: Logger | undefined
): Promise<void> {
  const create = () =>
    fs.writeFile(lockPath, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
  try {
    await create();
    return;
  } catch (err) {
    if (errorCode(err) !== "EEXIST") {
      throw err;
    }
  }

  const owner = await readOwner(fs, lockPath);
  if (!isStaleOwner(owner)) {
    throw new Error(`Data file is locked by process ${owner} (${lockPath})`);
  }

  logger?.warn({ lock: lockPath, pid: owner }, "taking over a stale lock");
  await ignoreMissing(fs.unlink(lockPath));
  try {
    await create();
  } catch (err) {
    if (errorCode(err) === "EEXIST") {
      const current = await readOwner(fs, lockPath).catch(() => "");
      throw new Error(
        `Data file is locked by process ${current || "unknown"} (${lockPath})`,
        { cause: err }
      );
    }
    throw err;
  }
}

async function removeTempFiles(
  fs: FileSystem,
  file: string,
  logger: Logger | undefined
): Promise<void> {
  const dir = path.dirname(file);
  const prefix = `.${path.basename(file)}.`;
  const leftovers = (await fs.readdir(dir)).filter(
    (name) =>
      name.startsWith(prefix) && TEMP_SUFFIX.test(name.slice(prefix.length))
  );
  if (leftovers.length === 0) {
    return;
  }
  await Promise.all(
    leftovers.map((name) => ignoreMissing(fs.unlink(path.join(dir, name))))
  );
  logger?.warn(
    { count: leftovers.length, file },
    "removed leftover temp files"
  );
}

async function loadRecords<T extends Versioned>(
  fs: FileSystem,
  file: string,
  schema: z.ZodType<T>
): Promise<Map<string, T>> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (err) {
    if (errorCode(err) === "ENOENT") {
      return new Map();
    }
    throw err;
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    // V8's SyntaxError quotes the file's text, which may hold record contents.
    // biome-ignore lint/style/useErrorCause: the cause would leak that text
    throw new Error(`Data file ${file} is not valid JSON`);
  }

  const envelope = z.object({
    formatVersion: z.literal(FORMAT_VERSION),
    records: z.array(schema),
  });
  const result = envelope.safeParse(json);
  if (!result.success) {
    throw new Error(
      `Data file ${file} is invalid\n${z.prettifyError(result.error)}`
    );
  }

  const records = new Map<string, T>();
  for (const record of result.data.records) {
    if (records.has(record.id)) {
      throw new Error(`Data file ${file} contains duplicate record IDs`);
    }
    records.set(record.id, record);
  }
  return records;
}

export async function createFileRepository<T extends Versioned>({
  file: target,
  fs = nodeFs,
  logger,
  schema,
}: FileRepositoryOptions<T>): Promise<FileRepository<T>> {
  const file = path.resolve(target);
  const dir = path.dirname(file);
  const lockPath = `${file}.lock`;

  if (openFiles.has(file)) {
    throw new Error(`Data file ${file} is already open in this process`);
  }
  openFiles.add(file);

  let records: Map<string, T>;
  let locked = false;
  try {
    await fs.mkdir(dir, { mode: 0o700, recursive: true });
    await acquireLock(fs, lockPath, logger);
    locked = true;
    await removeTempFiles(fs, file, logger);
    records = await loadRecords(fs, file, schema);
  } catch (err) {
    if (locked) {
      await ignoreMissing(fs.unlink(lockPath)).catch(() => undefined);
    }
    openFiles.delete(file);
    throw err;
  }

  let healthy = true;
  let closed = false;
  let closing: Promise<void> | undefined;
  let tail: Promise<unknown> = Promise.resolve();

  const closedError = () => new Error(`Data file ${file} is closed`);

  const enqueue = <R>(operation: () => Promise<R>): Promise<R> => {
    if (closed) {
      return Promise.reject(closedError());
    }
    const run = tail.then(operation);
    tail = run.catch(() => undefined);
    return run;
  };

  const read = <R>(operation: () => R): Promise<R> =>
    new Promise((resolve) => {
      if (closed) {
        throw closedError();
      }
      resolve(operation());
    });

  const writeTemp = async (tempPath: string, data: string): Promise<void> => {
    const handle = await fs.open(tempPath, "wx", 0o600);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } catch (err) {
      await handle.close().catch(() => undefined);
      throw err;
    }
    await handle.close();
  };

  // Without syncing the directory, a power loss can undo the rename itself.
  const syncDirectory = async (): Promise<void> => {
    const handle = await fs.open(dir, "r");
    try {
      await handle.sync();
    } catch (err) {
      if (!UNSUPPORTED_DIRECTORY_SYNC.has(errorCode(err))) {
        await handle.close().catch(() => undefined);
        throw err;
      }
    }
    await handle.close();
  };

  const commit = async (next: Map<string, T>): Promise<void> => {
    const data = `${JSON.stringify(
      { formatVersion: FORMAT_VERSION, records: [...next.values()] },
      null,
      2
    )}\n`;
    const tempPath = path.join(
      dir,
      `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`
    );
    try {
      await writeTemp(tempPath, data);
      await fs.rename(tempPath, file);
    } catch (err) {
      healthy = false;
      await ignoreMissing(fs.unlink(tempPath)).catch(() => undefined);
      throw err;
    }

    // The file already holds the new state, so memory must follow it even if only durability is in doubt.
    try {
      await syncDirectory();
      healthy = true;
    } catch (err) {
      healthy = false;
      logger?.error({ err, file }, "syncing the data directory failed");
    }
    records = next;
  };

  return {
    close: () => {
      closing ??= (async () => {
        closed = true;
        try {
          await tail;
          await ignoreMissing(fs.unlink(lockPath));
        } finally {
          openFiles.delete(file);
        }
      })();
      return closing;
    },

    find: (predicate) =>
      read(() => {
        const copies = [...records.values()].map((record) =>
          structuredClone(record)
        );
        return predicate
          ? copies.filter((record) => predicate(record))
          : copies;
      }),

    get: (id) =>
      read(() => {
        const record = records.get(id);
        return record && structuredClone(record);
      }),

    insert: (record) =>
      enqueue(async () => {
        if (records.has(record.id)) {
          throw new DuplicateRecordError({ id: record.id });
        }
        const stored = { ...structuredClone(record), version: 1 } as T;
        const next = new Map(records);
        next.set(stored.id, stored);
        await commit(next);
        return structuredClone(stored);
      }),

    isHealthy: () => healthy && !closed,

    update: (id, expectedVersion, patch) =>
      enqueue(async () => {
        const current = records.get(id);
        if (!current) {
          throw new RecordNotFoundError({ id });
        }
        if (current.version !== expectedVersion) {
          throw new VersionConflictError({ id });
        }
        const changes = Object.fromEntries(
          Object.entries(structuredClone(patch)).filter(
            ([, value]) => value !== undefined
          )
        );
        const updated = {
          ...current,
          ...changes,
          id: current.id,
          version: expectedVersion + 1,
        } as T;
        const next = new Map(records);
        next.set(id, updated);
        await commit(next);
        return structuredClone(updated);
      }),
  };
}

export function storageCheck(
  repository: Pick<FileRepository<Versioned>, "isHealthy">,
  name = "storage"
): ReadinessCheck {
  return { check: () => repository.isHealthy(), name };
}
