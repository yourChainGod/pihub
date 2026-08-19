import { pihubNoStoreHeaders } from "@/lib/pihub-auth-http";
import { getPihubAuthenticationMetadata } from "@/lib/pihub-auth";

const RELEASE_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function getServerVersion(): string | null {
  const version = process.env.PIHUB_SERVER_VERSION;
  return typeof version === "string" && RELEASE_VERSION_PATTERN.test(version) ? version : null;
}

export function GET() {
  return Response.json({
    status: "ok",
    version: getServerVersion(),
    authentication: getPihubAuthenticationMetadata(),
  }, {
    headers: pihubNoStoreHeaders(),
  });
}
