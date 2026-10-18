import type { Server } from "node:http";
import type { Express } from "express";

export function listen(app: Express, port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, (err) =>
      err ? reject(err) : resolve(server)
    );
  });
}
