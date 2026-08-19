import {
  consumePihubPairingClaimAttempt,
  getPihubAuthenticationMetadata,
} from "@/lib/pihub-auth";
import {
  pihubNoStoreHeaders,
  readPihubAuthJsonBody,
} from "@/lib/pihub-auth-http";
import { claimPihubPairingCode } from "@/lib/pihub-auth-store";
import { PihubAuthInputError } from "@/lib/pihub-auth-shared";

export async function POST(request: Request) {
  try {
    const body = await readPihubAuthJsonBody(request);
    const rateLimit = consumePihubPairingClaimAttempt(body.code);
    if (!rateLimit.allowed) {
      return Response.json({ error: "Too many pairing attempts" }, {
        status: 429,
        headers: pihubNoStoreHeaders({
          "Retry-After": String(rateLimit.retryAfterSeconds),
        }),
      });
    }
    const device = await claimPihubPairingCode(body.code);
    if (!device) {
      return Response.json({ error: "Invalid pairing code" }, {
        status: 401,
        headers: pihubNoStoreHeaders(),
      });
    }

    return Response.json({
      device,
      authentication: getPihubAuthenticationMetadata(),
    }, {
      status: 201,
      headers: pihubNoStoreHeaders(),
    });
  } catch (error) {
    if (error instanceof PihubAuthInputError) {
      return Response.json({ error: "Invalid request" }, {
        status: 400,
        headers: pihubNoStoreHeaders(),
      });
    }
    return Response.json({ error: "Pairing service unavailable" }, {
      status: 503,
      headers: pihubNoStoreHeaders(),
    });
  }
}
