import { NextResponse } from "next/server";
import { getTrustedPihubRequestContext } from "@/lib/pihub-auth";
import { pihubNoStoreHeaders } from "@/lib/pihub-auth-http";
import { isApiRequestAllowed } from "@/lib/request-security";
import {
  getTerminal,
  subscribeTerminal,
  TerminalCapacityError,
  type TerminalEvent,
  touchTerminal,
} from "@/lib/pihub-terminal";

export const dynamic = "force-dynamic";
const HEARTBEAT_MS = 15_000;

function jsonError(status: 401 | 403 | 404 | 429, message: string): Response {
  return NextResponse.json({ error: message }, {
    status,
    headers: pihubNoStoreHeaders(status === 401
      ? { "WWW-Authenticate": 'PiHub-HMAC-SHA256 realm="PiHub"' }
      : undefined),
  });
}

function sseHeaders(): Headers {
  const headers = pihubNoStoreHeaders({
    "Content-Type": "text/event-stream; charset=utf-8",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    "X-Content-Type-Options": "nosniff",
  });
  headers.set("Cache-Control", "no-store, no-cache, max-age=0, no-transform");
  return headers;
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isApiRequestAllowed(request)) return jsonError(403, "Untrusted API request");
  const authorization = getTrustedPihubRequestContext(request);
  if (!authorization) return jsonError(401, "Authentication required");
  if (!authorization.capabilities.includes("terminal:use")) {
    return jsonError(403, "Terminal capability required");
  }
  const ownerId = authorization.deviceId;
  const { id } = await params;
  if (!id || id.length > 128 || /[\0\r\n]/.test(id)) return jsonError(404, "Terminal not found");
  const terminal = getTerminal(id, ownerId);
  if (!terminal) return jsonError(404, "Terminal not found");

  const encoder = new TextEncoder();
  const pending: TerminalEvent[] = [];
  let eventSink: (event: TerminalEvent) => void = (event) => {
    pending.push(event);
  };
  let unsubscribe: (() => void) | null;
  try {
    unsubscribe = subscribeTerminal(id, ownerId, (event) => eventSink(event));
  } catch (error) {
    if (error instanceof TerminalCapacityError && error.code === "SUBSCRIBER_LIMIT") {
      return jsonError(429, error.message);
    }
    throw error;
  }
  if (!unsubscribe) return jsonError(404, "Terminal not found");
  if (request.signal.aborted) {
    unsubscribe();
    return new Response(null, { status: 204, headers: pihubNoStoreHeaders() });
  }

  const initialOutput = terminal.output;
  let cleanup: (closeController: boolean) => void = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      const finish = (closeController: boolean) => {
        if (closed) return;
        closed = true;
        request.signal.removeEventListener("abort", onAbort);
        if (heartbeat) {
          clearInterval(heartbeat);
          heartbeat = null;
        }
        unsubscribe?.();
        unsubscribe = null;
        if (closeController) {
          try { controller.close(); } catch { /* The consumer already canceled. */ }
        }
      };
      const sendBytes = (bytes: Uint8Array) => {
        if (closed) return;
        try {
          controller.enqueue(bytes);
          if (controller.desiredSize !== null && controller.desiredSize < 0) finish(true);
        } catch {
          finish(false);
        }
      };
      const sendEvent = (event: TerminalEvent) => {
        sendBytes(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        if (event.type === "exit") finish(true);
      };
      const onAbort = () => finish(true);

      cleanup = finish;
      eventSink = sendEvent;
      request.signal.addEventListener("abort", onAbort, { once: true });
      if (initialOutput) sendEvent({ type: "output", data: initialOutput });
      for (const event of pending.splice(0)) sendEvent(event);
      if (closed) return;

      heartbeat = setInterval(() => {
        if (!touchTerminal(id, ownerId)) {
          finish(true);
          return;
        }
        sendBytes(encoder.encode(": keepalive\n\n"));
      }, HEARTBEAT_MS);
      heartbeat.unref?.();
    },
    cancel() {
      cleanup(false);
    },
  });
  return new Response(stream, { headers: sseHeaders() });
}
