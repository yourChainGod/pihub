import {
  pihubNoStoreHeaders,
  readPihubAuthJsonBody,
} from "@/lib/pihub-auth-http";
import {
  issuePihubPairingCode,
  listPihubAuthState,
  PihubAuthStateConflictError,
  revokePihubDevice,
  rotatePihubDeviceSecret,
} from "@/lib/pihub-auth-store";
import { PihubAuthInputError } from "@/lib/pihub-auth-shared";
import { getTrustedPihubRequestContext } from "@/lib/pihub-auth";

function jsonError(status: 400 | 401 | 404 | 409 | 503, message: string) {
  return Response.json({ error: message }, {
    status,
    headers: pihubNoStoreHeaders(),
  });
}

function mutationError(error: unknown) {
  if (error instanceof PihubAuthInputError) return jsonError(400, "Invalid request");
  if (error instanceof PihubAuthStateConflictError) return jsonError(409, "Authentication state conflict");
  return jsonError(503, "Authentication service unavailable");
}

function requireDeviceManager(request: Request) {
  const context = getTrustedPihubRequestContext(request);
  if (!context) return { response: jsonError(401, "Authentication required") } as const;
  if (!context.capabilities.includes("devices:manage")) {
    return { response: Response.json({ error: "Insufficient device capability" }, {
      status: 403,
      headers: pihubNoStoreHeaders(),
    }) } as const;
  }
  return { context } as const;
}

export async function GET(request: Request) {
  const authorization = requireDeviceManager(request);
  if ("response" in authorization) return authorization.response;
  try {
    return Response.json(await listPihubAuthState(), {
      headers: pihubNoStoreHeaders(),
    });
  } catch {
    return jsonError(503, "Authentication service unavailable");
  }
}

export async function POST(request: Request) {
  const authorization = requireDeviceManager(request);
  if ("response" in authorization) return authorization.response;
  try {
    const body = await readPihubAuthJsonBody(request);
    const ttlMs = body.ttlSeconds === undefined
      ? undefined
      : typeof body.ttlSeconds === "number"
        ? body.ttlSeconds * 1000
        : Number.NaN;
    const pairingCode = await issuePihubPairingCode({
      label: body.label,
      capabilities: body.capabilities,
      ttlMs,
    });
    return Response.json({ pairingCode }, {
      status: 201,
      headers: pihubNoStoreHeaders(),
    });
  } catch (error) {
    return mutationError(error);
  }
}

export async function PATCH(request: Request) {
  const authorization = requireDeviceManager(request);
  if ("response" in authorization) return authorization.response;
  try {
    const body = await readPihubAuthJsonBody(request);
    if (body.deviceId !== authorization.context.deviceId) {
      return Response.json({ error: "A device may only rotate its own secret" }, {
        status: 403,
        headers: pihubNoStoreHeaders(),
      });
    }
    const device = await rotatePihubDeviceSecret(body.deviceId);
    return Response.json({ device }, {
      headers: pihubNoStoreHeaders(),
    });
  } catch (error) {
    return mutationError(error);
  }
}

export async function DELETE(request: Request) {
  const authorization = requireDeviceManager(request);
  if ("response" in authorization) return authorization.response;
  try {
    const deviceId = new URL(request.url).searchParams.get("deviceId");
    if (!deviceId) return jsonError(400, "Invalid request");
    await revokePihubDevice(deviceId);
    return new Response(null, {
      status: 204,
      headers: pihubNoStoreHeaders(),
    });
  } catch (error) {
    return mutationError(error);
  }
}
