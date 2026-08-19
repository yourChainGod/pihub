import { randomUUID } from "node:crypto";
import type { AuthEvent, AuthPrompt } from "@earendil-works/pi-ai";
import { SseReplayChannel } from "@/lib/event-replay";
import { invalidateModelsCache } from "@/lib/models-cache";
import { getTrustedPihubRequestContext } from "@/lib/pihub-auth";
import { pihubNoStoreHeaders, readPihubAuthJsonBody } from "@/lib/pihub-auth-http";
import { PihubAuthInputError } from "@/lib/pihub-auth-shared";
import { createSafeModelRuntime } from "@/lib/safe-model-runtime";
import {
  TemporaryChallengeCapacityError,
  TemporaryChallengeError,
  acquireTemporaryChallengeFlow,
  consumeTemporaryChallenge,
  createTemporaryChallenge,
  type TemporaryChallenge,
} from "@/lib/temporary-challenge";

export const dynamic = "force-dynamic";

const MAX_LOGIN_BODY_BYTES = 24 * 1024;
const MAX_LOGIN_CODE_LENGTH = 16 * 1024;

function validProvider(provider: string): boolean {
  return provider.length > 0 && provider.length <= 128 && !/[\0\r\n]/.test(provider);
}

function jsonError(status: 400 | 401 | 403 | 404 | 409 | 410 | 429, message: string): Response {
  return Response.json({ error: message }, {
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

// POST /api/auth/login/[provider] - submit one manual redirect/code response.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ provider: string }> },
) {
  const trusted = getTrustedPihubRequestContext(req);
  if (!trusted) return jsonError(401, "Authentication required");
  if (!trusted.capabilities.includes("providers:manage")) {
    return jsonError(403, "Insufficient device capability");
  }

  const { provider } = await params;
  if (!validProvider(provider)) return jsonError(400, "Invalid provider");

  let body: Record<string, unknown>;
  try {
    body = await readPihubAuthJsonBody(req, MAX_LOGIN_BODY_BYTES);
  } catch (error) {
    if (error instanceof PihubAuthInputError) return jsonError(400, error.message);
    throw error;
  }
  const token = body.token;
  const code = body.code;
  if (
    typeof token !== "string"
    || typeof code !== "string"
    || !code.trim()
    || code.length > MAX_LOGIN_CODE_LENGTH
  ) {
    return jsonError(400, "token and code required");
  }

  const status = consumeTemporaryChallenge(token, trusted.deviceId, provider, code.trim());
  if (status === "consumed") {
    return Response.json({ ok: true, provider }, { headers: pihubNoStoreHeaders() });
  }
  if (status === "replayed") return jsonError(409, "Login response was already used");
  if (status === "expired") return jsonError(410, "Login request expired");
  return jsonError(404, "No matching pending login");
}

// GET /api/auth/login/[provider] - authenticated SSE stream for one OAuth flow.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ provider: string }> },
) {
  const trusted = getTrustedPihubRequestContext(req);
  if (!trusted) return jsonError(401, "Authentication required");
  if (!trusted.capabilities.includes("providers:manage")) {
    return jsonError(403, "Insufficient device capability");
  }

  const { provider } = await params;
  if (!validProvider(provider)) return jsonError(400, "Invalid provider");
  const flowLease = acquireTemporaryChallengeFlow(trusted.deviceId, provider);
  if (!flowLease) return jsonError(429, "Too many concurrent login flows");

  const abort = new AbortController();
  const activeChallenges = new Set<TemporaryChallenge>();
  let transportCleaned = false;
  const cleanupTransport = () => {
    if (transportCleaned) return;
    transportCleaned = true;
    abort.abort();
    for (const challenge of activeChallenges) challenge.cancel();
    activeChallenges.clear();
  };

  const channel = new SseReplayChannel(
    `oauth:${JSON.stringify([trusted.deviceId, provider, randomUUID()])}`,
    { maxReplayBytes: 128 * 1024, maxReplayFrames: 64 },
  );
  const opened = channel.open(req, {
    connectionGroup: `device:${JSON.stringify(trusted.deviceId)}`,
    maxConnectionsPerScope: 1,
    onClose: cleanupTransport,
  });
  if (!opened.accepted) {
    cleanupTransport();
    flowLease.release();
    if (opened.status === 204) {
      return new Response(null, { status: 204, headers: pihubNoStoreHeaders() });
    }
    return jsonError(429, "Too many event streams");
  }

  const { connection } = opened;
  connection.activate();
  const send = (data: unknown): boolean => {
    if (connection.closed) return false;
    if (channel.publish(data) === null) {
      connection.close();
      return false;
    }
    return !connection.closed;
  };

  const createClientInputRequest = (): TemporaryChallenge => {
    if (abort.signal.aborted) {
      throw new TemporaryChallengeError("cancelled", "Login cancelled");
    }
    const challenge = createTemporaryChallenge(trusted.deviceId, provider);
    activeChallenges.add(challenge);
    challenge.promise
      .finally(() => activeChallenges.delete(challenge))
      .catch(() => {});
    return challenge;
  };

  void (async () => {
    let pendingManualRequest: TemporaryChallenge | undefined;
    const getManualInputRequest = () => {
      if (!pendingManualRequest) {
        const challenge = createClientInputRequest();
        pendingManualRequest = challenge;
        challenge.promise
          .finally(() => {
            if (pendingManualRequest === challenge) pendingManualRequest = undefined;
          })
          .catch(() => {});
      }
      return pendingManualRequest;
    };

    try {
      const modelRuntime = await createSafeModelRuntime({ modelsPath: null, signal: abort.signal });
      if (abort.signal.aborted) throw new TemporaryChallengeError("cancelled", "Login cancelled");
      if (!modelRuntime.getProvider(provider)?.auth.oauth) {
        send({ type: "error", message: `Unknown provider: ${provider}` });
        return;
      }

      await modelRuntime.login(provider, "oauth", {
        prompt: async (prompt: AuthPrompt) => {
          const request = prompt.type === "manual_code"
            ? getManualInputRequest()
            : createClientInputRequest();
          if (prompt.type === "select") {
            send({
              type: "select_request",
              message: prompt.message,
              options: prompt.options,
              token: request.token,
            });
          } else {
            send({
              type: "prompt_request",
              message: prompt.message,
              placeholder: prompt.placeholder ?? null,
              token: request.token,
            });
          }
          return request.promise;
        },
        notify: (event: AuthEvent) => {
          if (event.type === "auth_url") {
            const request = getManualInputRequest();
            send({
              type: "auth",
              url: event.url,
              instructions: event.instructions ?? null,
              token: request.token,
            });
          } else if (event.type === "device_code") {
            send({
              type: "device_code",
              userCode: event.userCode,
              verificationUri: event.verificationUri,
              intervalSeconds: event.intervalSeconds ?? null,
              expiresInSeconds: event.expiresInSeconds ?? null,
            });
          } else {
            send({ type: "progress", message: event.message });
          }
        },
        signal: abort.signal,
      });

      if (abort.signal.aborted) throw new TemporaryChallengeError("cancelled", "Login cancelled");
      invalidateModelsCache();
      send({ type: "success" });
    } catch (error) {
      if (error instanceof TemporaryChallengeCapacityError) {
        send({ type: "error", message: error.message });
      } else if (error instanceof TemporaryChallengeError && error.code === "expired") {
        send({ type: "error", message: "Login request expired" });
      } else if (abort.signal.aborted || (
        error instanceof TemporaryChallengeError && error.code === "cancelled"
      )) {
        send({ type: "cancelled" });
      } else {
        send({ type: "error", message: "Authentication failed" });
      }
    } finally {
      cleanupTransport();
      flowLease.release();
      connection.close();
    }
  })();

  return new Response(opened.stream, { headers: sseHeaders() });
}
