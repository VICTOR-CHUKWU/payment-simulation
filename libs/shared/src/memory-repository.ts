import {
  DuplicateRecordError,
  firstMatch,
  matchesWhere,
  RecordNotFoundError,
  type Repository,
  VersionConflictError,
  type Versioned,
} from "./repository.js";

// The executor runs synchronously, so each operation stays atomic, and a throw
// (a failing predicate or an uncloneable value) becomes a rejection.
const settle = <R>(operation: () => R): Promise<R> =>
  new Promise((resolve) => {
    resolve(operation());
  });

export function createMemoryRepository<T extends Versioned>(): Repository<T> {
  const records = new Map<string, T>();

  return {
    find: (predicate) =>
      settle(() => {
        const copies = [...records.values()].map((record) =>
          structuredClone(record)
        );
        return predicate
          ? copies.filter((record) => predicate(record))
          : copies;
      }),

    findOne: (predicate) =>
      settle(() => firstMatch(records.values(), predicate)),

    findOneBy: (where) =>
      settle(() => firstMatch(records.values(), matchesWhere<T>(where))),

    get: (id) =>
      settle(() => {
        const record = records.get(id);
        return record && structuredClone(record);
      }),

    insert: (record) =>
      settle(() => {
        if (records.has(record.id)) {
          throw new DuplicateRecordError({ id: record.id });
        }
        const stored = { ...structuredClone(record), version: 1 } as T;
        records.set(stored.id, stored);
        return structuredClone(stored);
      }),

    update: (id, expectedVersion, patch) =>
      settle(() => {
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
        const next = {
          ...current,
          ...changes,
          id: current.id,
          version: expectedVersion + 1,
        } as T;
        records.set(id, next);
        return structuredClone(next);
      }),
  };
}
