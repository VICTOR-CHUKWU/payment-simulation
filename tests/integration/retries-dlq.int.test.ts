import {
  api,
  createPayment,
  DEMO,
  type DlqItem,
  emailsFor,
  login,
  logsMatching,
  mailpit,
  messageIdFor,
  type Services,
  startServices,
  stopServices,
  waitFor,
  waitForDlq,
  waitForNotifications,
  waitForStatus,
} from "./harness.js";

const EMAILED = ["payment.created", "payment.succeeded"];

describe("email retries and dead-lettering", () => {
  let services: Services;
  let token: string;
  let adminToken: string;

  const deadLetteredPayment = async (errorCode: number) => {
    await mailpit.chaos({ errorCode });
    const payment = await createPayment(token);
    await waitForStatus(token, payment.id, "succeeded", services);
    const items = await waitForDlq(adminToken, payment.id, 2, services);
    return { items, payment };
  };

  beforeAll(async () => {
    await mailpit.chaos();
    await mailpit.clear();
    services = await startServices();
    token = await login(DEMO.user);
    adminToken = await login(DEMO.admin);
  });

  afterEach(async () => {
    await mailpit.chaos();
  });

  afterAll(async () => {
    await mailpit.chaos();
    await stopServices();
  });

  it("retries a temporary failure and dead-letters it once attempts run out", async () => {
    const { items, payment } = await deadLetteredPayment(451);

    expect(items.map((item) => item.event.type).sort()).toEqual(EMAILED);
    for (const item of items) {
      expect(item).toMatchObject({ attempts: 3, reason: "exhausted" });
      const { eventId } = item.event;
      const retries = logsMatching(services, "notification", {
        eventId,
        msg: "email send failed, retrying",
      });
      expect(retries.map((line) => line.attempt)).toEqual([1, 2]);
      expect(
        logsMatching(services, "notification", {
          eventId,
          msg: "email dead-lettered",
        })
      ).toEqual([expect.objectContaining({ attempt: 3, reason: "exhausted" })]);
    }

    await waitForNotifications(token, payment.id, EMAILED, services);
    expect(await emailsFor(items.map((item) => item.event.eventId))).toEqual(
      []
    );
  });

  it("dead-letters a permanent rejection on the first attempt", async () => {
    const { items } = await deadLetteredPayment(550);

    expect(items.map((item) => item.event.type).sort()).toEqual(EMAILED);
    for (const item of items) {
      expect(item).toMatchObject({ attempts: 1, reason: "rejected" });
      expect(
        logsMatching(services, "notification", {
          eventId: item.event.eventId,
          msg: "email send failed, retrying",
        })
      ).toEqual([]);
    }
  });

  it("replays a dead-lettered email once the SMTP server accepts it", async () => {
    const { items } = await deadLetteredPayment(550);
    const [entry] = items as [DlqItem];
    const replay = () =>
      api("notification", `/admin/dlq/${entry.seq}/replay`, {
        method: "POST",
        token: adminToken,
      });

    const refused = await replay();
    expect(refused.status).toBe(502);
    expect(refused.body).toMatchObject({ code: "email-send-failed" });
    expect(
      (
        await api("notification", `/admin/dlq/${entry.seq}`, {
          token: adminToken,
        })
      ).status
    ).toBe(200);

    await mailpit.chaos();
    const replayed = await replay();
    expect(replayed.status).toBe(200);
    expect(replayed.body).toMatchObject({
      data: { eventId: entry.event.eventId, seq: entry.seq },
    });

    const [email] = await waitFor(
      async () => {
        const found = await emailsFor([entry.event.eventId]);
        return found.length > 0 ? found : undefined;
      },
      { description: "the replayed email in Mailpit", services }
    );
    expect(email?.MessageID).toBe(messageIdFor(entry.event.eventId));
    expect(
      (
        await api("notification", `/admin/dlq/${entry.seq}`, {
          token: adminToken,
        })
      ).status
    ).toBe(404);
  });

  it("keeps the DLQ routes from a normal user", async () => {
    const routes = [
      { method: "GET", path: "/admin/dlq" },
      { method: "GET", path: "/admin/dlq/1" },
      { method: "POST", path: "/admin/dlq/1/replay" },
    ];
    for (const { method, path } of routes) {
      // biome-ignore lint/performance/noAwaitInLoops: one request at a time keeps failures readable
      const res = await api("notification", path, { method, token });
      expect(res.status).toBe(403);
    }
  });
});
