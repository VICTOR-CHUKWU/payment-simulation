import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export const NATS_URL = "nats://127.0.0.1:4223";
const MAILPIT_URL = "http://127.0.0.1:8026";

export const SERVICE_URLS = {
  auth: "http://127.0.0.1:4101",
  notification: "http://127.0.0.1:4103",
  payment: "http://127.0.0.1:4102",
} as const;

export type ServiceName = keyof typeof SERVICE_URLS;

const SERVICE_NAMES = Object.keys(SERVICE_URLS) as ServiceName[];

export const DEMO = {
  admin: { email: "admin@example.com", password: "Admin123!" },
  user: { email: "user@example.com", password: "User123!" },
} as const;

const ENV = {
  AUTH_PORT: "4101",
  EMAIL_MAX_ATTEMPTS: "3",
  EMAIL_RETRY_DELAYS_MS: "200,400",
  GATEWAY_FAILURE_RATE: "0",
  GATEWAY_MAX_DELAY_MS: "50",
  GATEWAY_MIN_DELAY_MS: "10",
  GATEWAY_TIMEOUT_RATE: "0",
  LOG_LEVEL: "info",
  NATS_URL,
  NODE_ENV: "test",
  NOTIFICATION_PORT: "4103",
  OUTBOX_RELAY_INTERVAL_MS: "50",
  PAYMENT_PORT: "4102",
  PROCESSOR_POLL_INTERVAL_MS: "50",
  SMTP_HOST: "127.0.0.1",
  SMTP_PORT: "1026",
  STORAGE_DRIVER: "memory",
};

const STARTUP_TIMEOUT_MS = 20_000;
const STOP_TIMEOUT_MS = 10_000;
const OUTPUT_TAIL_LINES = 30;

export type LogLine = Record<string, unknown> & { msg?: string };

interface ServiceProcess {
  child: ChildProcess;
  lines: string[];
  name: ServiceName;
}

export interface Services {
  logs: (name: ServiceName) => LogLine[];
  stop: () => Promise<void>;
  tail: () => string;
}

function parseLine(line: string): LogLine | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    value = undefined;
  }
  return typeof value === "object" && value !== null
    ? (value as LogLine)
    : undefined;
}

function spawnService(name: ServiceName): ServiceProcess {
  // One node process per service, so signals and the SIGKILL fallback reach the service itself rather than a tsx wrapper.
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--conditions=development", "src/main.ts"],
    {
      cwd: resolve(ROOT, "services", name),
      env: { HOME: process.env.HOME, PATH: process.env.PATH, ...ENV },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  const lines: string[] = [];
  for (const stream of [child.stdout, child.stderr]) {
    if (stream) {
      createInterface({ input: stream }).on("line", (line) => lines.push(line));
    }
  }
  return { child, lines, name };
}

function tailOf(processes: ServiceProcess[]): string {
  return processes
    .map(
      ({ lines, name }) =>
        `--- ${name} (last ${OUTPUT_TAIL_LINES} lines)\n${lines.slice(-OUTPUT_TAIL_LINES).join("\n")}`
    )
    .join("\n");
}

const hasExited = ({ child }: ServiceProcess) =>
  child.exitCode !== null || child.signalCode !== null;

async function answers(name: ServiceName): Promise<boolean> {
  try {
    await fetch(`${SERVICE_URLS[name]}/health/live`);
    return true;
  } catch {
    return false;
  }
}

async function isReady(name: ServiceName): Promise<boolean> {
  try {
    const res = await fetch(`${SERVICE_URLS[name]}/health/ready`);
    return res.ok;
  } catch {
    return false;
  }
}

async function stopProcess(service: ServiceProcess): Promise<void> {
  const { child } = service;
  if (hasExited(service)) {
    return;
  }
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), STOP_TIMEOUT_MS);
  await exited;
  clearTimeout(timer);
}

let running: Services | undefined;

export async function startServices(): Promise<Services> {
  const inUse = await Promise.all(SERVICE_NAMES.map(answers));
  const taken = SERVICE_NAMES.filter((_name, i) => inUse[i]);
  if (taken.length > 0) {
    throw new Error(
      `Something already answers on ${taken.map((name) => SERVICE_URLS[name]).join(", ")}; stop it (a stale run?) before running the suite`
    );
  }
  const processes = SERVICE_NAMES.map(spawnService);
  const stop = async () => {
    await Promise.all(processes.map(stopProcess));
  };
  const tail = () => tailOf(processes);
  try {
    await waitFor(
      async () => {
        const exited = processes.find(hasExited);
        if (exited) {
          throw new Error(`${exited.name} exited during startup\n${tail()}`);
        }
        const ready = await Promise.all(SERVICE_NAMES.map(isReady));
        return ready.every(Boolean) || undefined;
      },
      { description: "all services ready", timeoutMs: STARTUP_TIMEOUT_MS }
    );
  } catch (err) {
    await stop();
    throw err;
  }
  running = {
    logs: (name) =>
      (processes.find((p) => p.name === name)?.lines ?? [])
        .map(parseLine)
        .filter((line): line is LogLine => line !== undefined),
    stop,
    tail,
  };
  return running;
}

export async function stopServices(): Promise<void> {
  await running?.stop();
  running = undefined;
}

export async function waitFor<T>(
  check: () => Promise<T | undefined> | T | undefined,
  {
    description,
    intervalMs = 100,
    services,
    timeoutMs = 15_000,
  }: {
    description: string;
    intervalMs?: number;
    services?: Services;
    timeoutMs?: number;
  }
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    // biome-ignore lint/performance/noAwaitInLoops: polling must run one check at a time
    last = await check();
    if (last !== undefined) {
      return last as T;
    }
    await new Promise((done) => setTimeout(done, intervalMs));
  }
  throw new Error(
    `Timed out after ${timeoutMs} ms waiting for ${description}${services ? `\n${services.tail()}` : ""}`
  );
}

export interface ApiResponse<T = unknown> {
  body: T;
  status: number;
}

export async function api<T = Record<string, unknown>>(
  service: ServiceName,
  path: string,
  {
    body,
    headers = {},
    method = "GET",
    token,
  }: {
    body?: unknown;
    headers?: Record<string, string>;
    method?: string;
    token?: string;
  } = {}
): Promise<ApiResponse<T>> {
  const res = await fetch(`${SERVICE_URLS[service]}${path}`, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...headers,
    },
    method,
  });
  const text = await res.text();
  return {
    body: (text ? JSON.parse(text) : undefined) as T,
    status: res.status,
  };
}

export async function login({
  email,
  password,
}: {
  email: string;
  password: string;
}): Promise<string> {
  const res = await api<{ data: { accessToken: string } }>(
    "auth",
    "/auth/login",
    { body: { email, password }, method: "POST" }
  );
  if (res.status !== 200) {
    throw new Error(`Login as ${email} returned ${res.status}`);
  }
  return res.body.data.accessToken;
}

export interface Payment {
  id: string;
  status: string;
}

export async function createPayment(
  token: string,
  headers: Record<string, string> = {}
): Promise<Payment> {
  const res = await api<{ data: Payment }>("payment", "/payments", {
    body: { amount: 150_000, currency: "NGN", description: "Integration" },
    headers,
    method: "POST",
    token,
  });
  if (res.status !== 201) {
    throw new Error(`POST /payments returned ${res.status}`);
  }
  return res.body.data;
}

export function waitForStatus(
  token: string,
  paymentId: string,
  status: string,
  services: Services
): Promise<Payment> {
  return waitFor(
    async () => {
      const res = await api<{ data?: Payment }>(
        "payment",
        `/payments/${paymentId}`,
        { token }
      );
      return res.body.data?.status === status ? res.body.data : undefined;
    },
    { description: `payment ${paymentId} to be ${status}`, services }
  );
}

export interface Notification {
  id: string;
  paymentId: string;
  type: string;
}

export async function notificationsFor(
  token: string,
  paymentId: string
): Promise<Notification[]> {
  const res = await api<{ data: Notification[] }>(
    "notification",
    "/notifications?limit=100",
    { token }
  );
  return res.body.data.filter((n) => n.paymentId === paymentId);
}

export function waitForNotifications(
  token: string,
  paymentId: string,
  types: readonly string[],
  services: Services
): Promise<Notification[]> {
  return waitFor(
    async () => {
      const found = await notificationsFor(token, paymentId);
      return types.every((type) => found.some((n) => n.type === type))
        ? found
        : undefined;
    },
    {
      description: `notifications ${types.join(", ")} for payment ${paymentId}`,
      services,
    }
  );
}

export interface DlqItem {
  attempts: number;
  event: { data: { paymentId: string }; eventId: string; type: string };
  reason: string;
  seq: number;
}

export async function dlqFor(
  adminToken: string,
  paymentId: string
): Promise<DlqItem[]> {
  const res = await api<{ data: DlqItem[] }>(
    "notification",
    "/admin/dlq?limit=100",
    { token: adminToken }
  );
  return res.body.data.filter(
    (item) => item.event.data.paymentId === paymentId
  );
}

export function waitForDlq(
  adminToken: string,
  paymentId: string,
  count: number,
  services: Services
): Promise<DlqItem[]> {
  return waitFor(
    async () => {
      const items = await dlqFor(adminToken, paymentId);
      return items.length >= count ? items : undefined;
    },
    { description: `${count} DLQ entries for payment ${paymentId}`, services }
  );
}

export function logsMatching(
  services: Services,
  name: ServiceName,
  match: Record<string, unknown>
): LogLine[] {
  return services
    .logs(name)
    .filter((line) =>
      Object.entries(match).every(([key, value]) => line[key] === value)
    );
}

export interface MailpitMessage {
  ID: string;
  MessageID: string;
  Subject: string;
  To: { Address: string }[];
}

export const mailpit = {
  async chaos(recipient?: { errorCode: number }): Promise<void> {
    const res = await fetch(`${MAILPIT_URL}/api/v1/chaos`, {
      body: JSON.stringify({
        Recipient: {
          ErrorCode: recipient?.errorCode ?? 451,
          Probability: recipient ? 100 : 0,
        },
      }),
      headers: { "content-type": "application/json" },
      method: "PUT",
    });
    if (!res.ok) {
      throw new Error(`Mailpit chaos returned ${res.status}`);
    }
  },
  async clear(): Promise<void> {
    await fetch(`${MAILPIT_URL}/api/v1/messages`, { method: "DELETE" });
  },
  async messages(): Promise<MailpitMessage[]> {
    const res = await fetch(`${MAILPIT_URL}/api/v1/messages?limit=500`);
    const body = (await res.json()) as { messages: MailpitMessage[] };
    return body.messages;
  },
};

export const messageIdFor = (eventId: string) =>
  `${eventId}@payment-simulation.local`;

export async function emailsFor(
  eventIds: readonly string[]
): Promise<MailpitMessage[]> {
  const ids = new Set(eventIds.map(messageIdFor));
  return (await mailpit.messages()).filter((m) => ids.has(m.MessageID));
}
