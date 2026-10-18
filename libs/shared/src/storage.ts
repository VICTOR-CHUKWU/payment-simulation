import path from "node:path";
import { z } from "zod";
import { createFileRepository, storageCheck } from "./file-repository.js";
import type { ReadinessCheck } from "./health.js";
import type { Logger } from "./logger.js";
import { createMemoryRepository } from "./memory-repository.js";
import type { Repository, Versioned } from "./repository.js";

const NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

export const storageConfigSchema = z.object({
  DATA_DIR: z.string().min(1).default("data"),
  STORAGE_DRIVER: z.enum(["memory", "file"]).default("file"),
});

export type StorageConfig = z.output<typeof storageConfigSchema>;

export interface OpenedRepository<T extends Versioned> {
  check: ReadinessCheck;
  close: () => Promise<void>;
  repository: Repository<T>;
}

export async function openRepository<T extends Versioned>({
  config,
  logger,
  name,
  schema,
}: {
  config: StorageConfig;
  logger?: Logger;
  name: string;
  schema: z.ZodType<T>;
}): Promise<OpenedRepository<T>> {
  if (!NAME_PATTERN.test(name)) {
    throw new Error(`Invalid repository name "${name}"`);
  }
  if (config.STORAGE_DRIVER === "memory") {
    return {
      check: { check: () => true, name: "storage" },
      close: () => Promise.resolve(),
      repository: createMemoryRepository<T>(),
    };
  }
  const repository = await createFileRepository({
    file: path.resolve(config.DATA_DIR, `${name}.json`),
    logger,
    schema,
  });
  return {
    check: storageCheck(repository),
    close: repository.close,
    repository,
  };
}
