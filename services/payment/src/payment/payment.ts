import { z } from "zod";
import { correlationIdSchema, outboxEntrySchema } from "./payment.outbox.js";

export const CURRENCIES = {
  EUR: 2,
  GBP: 2,
  NGN: 2,
  USD: 2,
} as const satisfies Record<string, number>;

export type Currency = keyof typeof CURRENCIES;

export const currencySchema = z.enum(
  Object.keys(CURRENCIES) as [Currency, ...Currency[]]
);

export const amountSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);

export const paymentStatusSchema = z.enum([
  "pending",
  "processing",
  "succeeded",
  "failed",
  "cancelled",
]);

export type PaymentStatus = z.infer<typeof paymentStatusSchema>;

export const failureReasonSchema = z.string().min(1).max(200);

export const idempotencyKeySchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[!-~]*$/, "Must be printable ASCII without spaces");

export const paymentFieldsSchema = z.object({
  amount: amountSchema,
  correlationId: correlationIdSchema.optional(),
  createdAt: z.iso.datetime(),
  currency: currencySchema,
  description: z.string().min(1).max(140).optional(),
  email: z.email(),
  failureReason: failureReasonSchema.optional(),
  id: z.uuid(),
  idempotencyKey: idempotencyKeySchema.optional(),
  outbox: z.array(outboxEntrySchema).optional(),
  status: paymentStatusSchema,
  updatedAt: z.iso.datetime(),
  userId: z.uuid(),
  version: z.number().int().positive(),
});

export const paymentSchema = paymentFieldsSchema.superRefine((payment, ctx) => {
  const failed = payment.status === "failed";
  if (failed && payment.failureReason === undefined) {
    ctx.addIssue({
      code: "custom",
      message: "Required when status is failed",
      path: ["failureReason"],
    });
  }
  if (!failed && payment.failureReason !== undefined) {
    ctx.addIssue({
      code: "custom",
      message: "Only allowed when status is failed",
      path: ["failureReason"],
    });
  }
});

export type Payment = z.infer<typeof paymentSchema>;
