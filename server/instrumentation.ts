import { realpathSync } from "node:fs";
import { join } from "node:path";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { trustedRegularExecutable } from "@/lib/trusted-executables";

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  shimPiCliArgvForExtensions();

  const { configureHttpDispatcher } = await import("@/lib/http-dispatcher");
  configureHttpDispatcher();
}

/**
 * Extensions that spawn Pi child agents can derive the CLI invocation from
 * `process.argv[1]`.
 * Under PiHub the host process is Next itself (`next/dist/bin/next`), which
 * does not understand pi CLI flags — every subagent child died instantly.
 * Point argv[1] at the real pi CLI entry (`dist/cli.js`) so those children
 * launch correctly. Nothing in Next depends on argv[1] after boot.
 */
function shimPiCliArgvForExtensions(): void {
  try {
    const packageDirectory = realpathSync(getPackageDir());
    const candidate = trustedRegularExecutable(join(packageDirectory, "dist", "cli.js"));
    if (candidate) process.argv[1] = candidate;
  } catch { /* bundled Pi CLI unavailable */ }
}
