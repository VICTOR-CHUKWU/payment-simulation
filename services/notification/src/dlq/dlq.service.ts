import {
  AppError,
  conflict,
  DLQ_STREAM,
  type Logger,
  notFound,
  type PageMeta,
} from "@payment-be/shared";
import { EmailSendError, type EmailService } from "../email/index.js";
import { type DlqEntry, dlqEntrySchema } from "./dlq.js";
import type { DlqItem } from "./dlq.schema.js";

export interface DlqStreams {
  streams: {
    deleteMessage: (stream: string, seq: number) => Promise<boolean>;
    getMessage: (
      stream: string,
      query: { seq: number }
    ) => Promise<{ data: Uint8Array; seq: number } | null>;
    info: (stream: string) => Promise<{
      state: { first_seq: number; last_seq: number; messages: number };
    }>;
  };
}

export interface DlqService {
  get: (seq: number, logger: Logger) => Promise<DlqItem>;
  list: (
    options: { limit: number; page: number },
    logger: Logger
  ) => Promise<{ items: DlqItem[]; meta: PageMeta }>;
  replay: (
    seq: number,
    logger: Logger
  ) => Promise<{ eventId: string; seq: number }>;
}

export const dlqEntryNotFound = () =>
  notFound("Dead-letter entry not found.", { code: "dlq-entry-not-found" });

const decoder = new TextDecoder();

function decode(data: Uint8Array): DlqEntry | undefined {
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(data));
  } catch {
    value = undefined;
  }
  const parsed = dlqEntrySchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

const toItem = (
  seq: number,
  { data: { channel: _channel, ...data }, occurredAt }: DlqEntry
): DlqItem => ({ ...data, deadLetteredAt: occurredAt, seq });

const sendFailed = ({ code, responseCode }: EmailSendError) =>
  new AppError({
    code: "email-send-failed",
    detail: `The SMTP server did not accept the email (${code ?? responseCode ?? "unknown error"}).`,
    status: 502,
  });

export function createDlqService({
  emailService,
  jsm,
}: {
  emailService: EmailService;
  jsm: DlqStreams;
}): DlqService {
  const stream = DLQ_STREAM.name;
  const replaying = new Set<number>();

  const read = async (seq: number, logger: Logger) => {
    const stored = await jsm.streams.getMessage(stream, { seq });
    if (stored === null) {
      return;
    }
    const entry = decode(stored.data);
    if (entry === undefined) {
      logger.warn({ seq }, "dlq entry malformed");
    }
    return entry;
  };

  const get = async (seq: number, logger: Logger) => {
    const entry = await read(seq, logger);
    if (entry === undefined) {
      throw dlqEntryNotFound();
    }
    return entry;
  };

  return {
    async get(seq, logger) {
      return toItem(seq, await get(seq, logger));
    },
    async list({ limit, page }, logger) {
      const {
        state: { first_seq: first, last_seq: last, messages: total },
      } = await jsm.streams.info(stream);
      const skip = (page - 1) * limit;
      const items: DlqItem[] = [];
      let found = 0;
      const lowest = Math.max(first, 1);
      for (let seq = last; seq >= lowest && items.length < limit; seq -= 1) {
        // biome-ignore lint/performance/noAwaitInLoops: sequences are read newest first until the page is full
        const entry = await read(seq, logger);
        if (entry !== undefined) {
          found += 1;
          if (found > skip) {
            items.push(toItem(seq, entry));
          }
        }
      }
      return {
        items,
        meta: { limit, page, total, totalPages: Math.ceil(total / limit) },
      };
    },
    async replay(seq, logger) {
      if (replaying.has(seq)) {
        throw conflict("This entry is already being replayed.", {
          code: "replay-in-progress",
        });
      }
      replaying.add(seq);
      try {
        const entry = await get(seq, logger);
        try {
          await emailService.send(entry.data.event, logger);
        } catch (err) {
          throw err instanceof EmailSendError ? sendFailed(err) : err;
        }
        let cause: unknown;
        const deleted = await jsm.streams
          .deleteMessage(stream, seq)
          .catch((err: unknown) => {
            cause = err;
            return false;
          });
        if (!deleted) {
          logger.error({ seq }, "dlq entry delete failed");
          throw new Error("DLQ entry delete failed", { cause });
        }
        const { eventId } = entry.data.event;
        logger.info({ eventId, seq }, "dlq entry replayed");
        return { eventId, seq };
      } finally {
        replaying.delete(seq);
      }
    },
  };
}
