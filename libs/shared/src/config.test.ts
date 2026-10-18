import { z } from "zod";
import { baseConfigSchema, loadConfig } from "./config.js";

const INVALID_NATS_URL = /Invalid environment configuration[\s\S]*NATS_URL/;
const INVALID_LOG_LEVEL = /Invalid environment configuration[\s\S]*LOG_LEVEL/;
const JWT_SECRET_NAMED = /JWT_SECRET/;

describe("loadConfig", () => {
  it("applies defaults to an empty env", () => {
    expect(loadConfig(baseConfigSchema, {})).toEqual({
      LOG_LEVEL: "info",
      NATS_URL: "nats://localhost:4222",
      NODE_ENV: "development",
    });
  });

  it("parses a valid env", () => {
    const env = {
      LOG_LEVEL: "warn",
      NATS_URL: "nats://nats.internal:4222",
      NODE_ENV: "production",
    };
    expect(loadConfig(baseConfigSchema, env)).toEqual(env);
  });

  it("names an invalid NATS_URL", () => {
    expect(() =>
      loadConfig(baseConfigSchema, { NATS_URL: "not a url" })
    ).toThrow(INVALID_NATS_URL);
  });

  it("names an invalid LOG_LEVEL", () => {
    expect(() => loadConfig(baseConfigSchema, { LOG_LEVEL: "loud" })).toThrow(
      INVALID_LOG_LEVEL
    );
  });

  it("does not echo invalid values", () => {
    const secret = "super-secret-value";
    const schema = z.object({ JWT_SECRET: z.string().min(64) });
    expect(() => loadConfig(schema, { JWT_SECRET: secret })).toThrow(
      JWT_SECRET_NAMED
    );
    expect(() => loadConfig(schema, { JWT_SECRET: secret })).not.toThrow(
      secret
    );
  });

  it("supports service schemas extending the base", () => {
    const schema = baseConfigSchema.extend({
      PORT: z.coerce.number().int().positive(),
    });
    expect(loadConfig(schema, { PORT: "3001" })).toMatchObject({
      NATS_URL: "nats://localhost:4222",
      PORT: 3001,
    });
  });
});
