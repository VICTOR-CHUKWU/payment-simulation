import { JetStreamApiError } from "@nats-io/jetstream";

export const isApiError = (
  err: unknown,
  code: number
): err is JetStreamApiError =>
  err instanceof JetStreamApiError && err.code === code;

const sameValue = (a: unknown, b: unknown): boolean =>
  Array.isArray(a) && Array.isArray(b)
    ? a.length === b.length && a.every((item, i) => item === b[i])
    : a === b;

export const matchesConfig = <T extends object>(
  current: Partial<T>,
  config: Partial<T>
): boolean =>
  Object.entries(config).every(([key, value]) =>
    sameValue(current[key as keyof T], value)
  );
