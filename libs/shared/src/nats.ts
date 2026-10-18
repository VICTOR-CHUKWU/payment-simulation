import type { JetStreamClient, PubAck } from "@nats-io/jetstream";
import {
  connect,
  headers,
  type MsgHdrs,
  type NatsConnection,
} from "@nats-io/transport-node";
import type { z } from "zod";
import { type EventEnvelope, eventEnvelopeSchema } from "./events.js";

export const CORRELATION_ID_HEADER = "x-correlation-id";

export function connectNats(options: {
  name: string;
  url: string;
}): Promise<NatsConnection> {
  return connect({ name: options.name, servers: options.url });
}

export function publishEvent<T>(
  js: Pick<JetStreamClient, "publish">,
  subject: string,
  event: EventEnvelope<T>,
  options: { correlationId?: string } = {}
): Promise<PubAck> {
  const msgHeaders = headers();
  if (options.correlationId) {
    msgHeaders.set(CORRELATION_ID_HEADER, options.correlationId);
  }
  return js.publish(subject, JSON.stringify(event), {
    headers: msgHeaders,
    msgID: event.eventId,
  });
}

export function parseEvent<T extends z.ZodType>(
  msg: { data: Uint8Array; headers?: MsgHdrs },
  dataSchema: T
) {
  const json: unknown = JSON.parse(new TextDecoder().decode(msg.data));
  const event = eventEnvelopeSchema(dataSchema).parse(json);
  const correlationId = msg.headers?.get(CORRELATION_ID_HEADER) || undefined;
  return { correlationId, event };
}
