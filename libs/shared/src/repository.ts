import { AppError } from "./errors.js";

export interface Versioned {
  id: string;
  version: number;
}

export type NewRecord<T> = T extends unknown ? Omit<T, "version"> : never;

export type RecordPatch<T> = T extends unknown
  ? Partial<Omit<T, "id" | "version">>
  : never;

export interface Repository<T extends Versioned> {
  find: (predicate?: (record: T) => boolean) => Promise<T[]>;
  get: (id: string) => Promise<T | undefined>;
  insert: (record: NewRecord<T>) => Promise<T>;
  update: (
    id: string,
    expectedVersion: number,
    patch: RecordPatch<T>
  ) => Promise<T>;
}

export class VersionConflictError extends AppError {
  readonly id: string;

  constructor({ id, cause }: { cause?: unknown; id: string }) {
    super({
      cause,
      code: "version-conflict",
      detail:
        "The resource was changed by another request. Fetch it and try again.",
      status: 409,
      title: "Version conflict",
    });
    this.name = "VersionConflictError";
    this.message = `Version conflict on record ${id}`;
    this.id = id;
  }
}

export class RecordNotFoundError extends AppError {
  readonly id: string;

  constructor({ id }: { id: string }) {
    super({
      code: "not-found",
      detail: "The requested resource does not exist.",
      plain: true,
      status: 404,
    });
    this.name = "RecordNotFoundError";
    this.message = `Record ${id} not found`;
    this.id = id;
  }
}

export class DuplicateRecordError extends Error {
  readonly id: string;

  constructor({ id }: { id: string }) {
    super(`Record ${id} already exists`);
    this.name = "DuplicateRecordError";
    this.id = id;
  }
}
