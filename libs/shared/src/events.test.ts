import { z } from "zod";
import { createEvent, eventEnvelopeSchema } from "./events.js";

const schema = eventEnvelopeSchema(z.object({ amount: z.number().int() }));

describe("createEvent", () => {
  it("sets a UUID and an ISO timestamp", () => {
    const event = createEvent("test.created", { amount: 100 });
    expect(z.uuid().safeParse(event.eventId).success).toBe(true);
    expect(z.iso.datetime().safeParse(event.occurredAt).success).toBe(true);
    expect(event).toMatchObject({
      data: { amount: 100 },
      type: "test.created",
    });
  });

  it("gives each event its own ID", () => {
    expect(createEvent("a", {}).eventId).not.toBe(createEvent("a", {}).eventId);
  });
});

describe("eventEnvelopeSchema", () => {
  it("accepts a created event", () => {
    const event = createEvent("test.created", { amount: 100 });
    expect(schema.parse(event)).toEqual(event);
  });

  it("rejects a bad eventId", () => {
    const event = { ...createEvent("t", { amount: 1 }), eventId: "nope" };
    expect(schema.safeParse(event).success).toBe(false);
  });

  it("rejects a missing type", () => {
    const { type: _type, ...event } = createEvent("t", { amount: 1 });
    expect(schema.safeParse(event).success).toBe(false);
  });

  it("rejects bad data", () => {
    const event = createEvent("t", { amount: 1.5 });
    expect(schema.safeParse(event).success).toBe(false);
  });
});
