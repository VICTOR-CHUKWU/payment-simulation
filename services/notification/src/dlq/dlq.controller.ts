import { sendData, sendPage } from "@payment-be/shared";
import type { RequestHandler } from "express";
import { dlqSeqParamsSchema, listDlqQuerySchema } from "./dlq.schema.js";
import type { DlqService } from "./dlq.service.js";

export interface DlqController {
  get: RequestHandler;
  list: RequestHandler;
  replay: RequestHandler;
}

export function createDlqController(service: DlqService): DlqController {
  return {
    async get(req, res) {
      const { seq } = dlqSeqParamsSchema.parse(req.params);
      sendData(res, await service.get(seq, req.log));
    },
    async list(req, res) {
      const { items, meta } = await service.list(
        listDlqQuerySchema.parse(req.query),
        req.log
      );
      sendPage(res, items, meta);
    },
    async replay(req, res) {
      const { seq } = dlqSeqParamsSchema.parse(req.params);
      sendData(res, await service.replay(seq, req.log), {
        message: "Email sent",
      });
    },
  };
}
