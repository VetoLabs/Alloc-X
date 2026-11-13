import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createConsoleServer } from "../apps/console/server.ts";

let serverPromise: ReturnType<typeof createConsoleServer> | undefined;

/**
 * Vercel Node Function adapter. The console's existing request router remains
 * authoritative; this adapter simply dispatches each platform request to it.
 */
export default async function handler(request: IncomingMessage, response: ServerResponse): Promise<void> {
  // Vercel functions can only write to /tmp; this is ephemeral demo state, NOT durable treasury storage.
  const sharedServer = serverPromise ??= createConsoleServer({ runtimeDirectory: join(tmpdir(), "alloc-x-console-demo") });
  const server = await sharedServer;
  server.emit("request", request, response);
}
