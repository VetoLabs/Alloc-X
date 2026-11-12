import type { IncomingMessage, ServerResponse } from "node:http";

import { createConsoleServer } from "../apps/console/server.ts";

let serverPromise: Promise<ReturnType<typeof createConsoleServer>> | undefined;

/**
 * Vercel Node Function adapter. The console's existing request router remains
 * authoritative; this adapter simply dispatches each platform request to it.
 */
export default async function handler(request: IncomingMessage, response: ServerResponse): Promise<void> {
  serverPromise ??= createConsoleServer();
  const server = await serverPromise;
  server.emit("request", request, response);
}
