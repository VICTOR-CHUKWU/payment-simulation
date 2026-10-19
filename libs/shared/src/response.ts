import type { Response } from "express";
import { z } from "zod";

export interface SendOptions {
  message?: string | null;
  status?: number;
}

export const pageMetaSchema = z
  .object({
    limit: z.int().min(1),
    page: z.int().min(1),
    total: z.int().min(0),
    totalPages: z.int().min(0),
  })
  .meta({ id: "PageMeta" });

export type PageMeta = z.infer<typeof pageMetaSchema>;

const envelopeShape = {
  message: z.string().nullable(),
  status: z.int().min(200).max(299),
  success: z.literal(true),
};

export function dataResponseSchema<T extends z.ZodType>(data: T) {
  return z.object({ ...envelopeShape, data });
}

export function pageResponseSchema<T extends z.ZodType>(item: T) {
  return z.object({
    ...envelopeShape,
    data: z.array(item),
    meta: pageMetaSchema,
  });
}

export function sendData(
  res: Response,
  data: unknown,
  { message = null, status = 200 }: SendOptions = {}
): void {
  res.status(status).json({ data, message, status, success: true });
}

export function sendPage(
  res: Response,
  items: readonly unknown[],
  meta: PageMeta,
  { message = null, status = 200 }: SendOptions = {}
): void {
  res
    .status(status)
    .json({ data: items, message, meta, status, success: true });
}
