import type { AddressInfo } from "node:net";
import express from "express";
import { listen } from "./server.js";

function close(server: { close: (cb: () => void) => unknown }) {
  return new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

describe("listen", () => {
  it("resolves with the server once it is listening", async () => {
    const server = await listen(express(), 0);
    expect(server.listening).toBe(true);
    await close(server);
  });

  it("rejects when the port is already in use", async () => {
    const first = await listen(express(), 0);
    const { port } = first.address() as AddressInfo;
    await expect(listen(express(), port)).rejects.toMatchObject({
      code: "EADDRINUSE",
    });
    await close(first);
  });
});
