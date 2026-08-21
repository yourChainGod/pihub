import type { NextRequest } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { privateRouteJson, requirePihubRouteCapability } from "@/lib/api-route-security";
import { BoundedCommandError, runBoundedCommand } from "@/lib/bounded-command";
import { createMinimalProcessEnvironment } from "@/lib/process-environment";
import { inspectDefaultExtensions } from "@/lib/default-extensions";
import {
  OutboundRequestError,
  readBoundedJsonRequest,
} from "@/lib/outbound-http-security";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { trustedRegularExecutable } from "@/lib/trusted-executables";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_SETUP_BODY_BYTES = 8 * 1024;
const LEGACY_EXTENSION_ACTIONS = new Set([
  "magic-context-install",
  "magic-context-doctor",
]);
const COMMAND_ENVIRONMENT = createMinimalProcessEnvironment(process.env, {
  overrides: { FORCE_COLOR: "0", NO_COLOR: "1" },
});

function absoluteWindowsEnvironmentPath(name: string): string | null {
  const key = Object.keys(process.env).find((candidate) => candidate.toUpperCase() === name.toUpperCase());
  const value = key ? process.env[key]?.trim() : undefined;
  return value && !value.includes("\0") && path.win32.isAbsolute(value) ? value : null;
}

function tailscaleCandidates(): string[] {
  if (process.platform === "win32") {
    const programFiles = absoluteWindowsEnvironmentPath("ProgramFiles");
    return programFiles ? [path.win32.join(programFiles, "Tailscale", "tailscale.exe")] : [];
  }
  if (process.platform === "darwin") {
    return [
      "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
      "/usr/local/bin/tailscale",
    ];
  }
  return ["/usr/bin/tailscale", "/usr/local/bin/tailscale", "/snap/bin/tailscale"];
}

async function tailscaleBinary(signal: AbortSignal): Promise<string | null> {
  for (const candidate of tailscaleCandidates()) {
    const executable = trustedRegularExecutable(candidate);
    if (!executable) continue;
    try {
      await runBoundedCommand(executable, ["version"], {
        environment: COMMAND_ENVIRONMENT,
        outputLimit: 4096,
        signal,
        timeout: 1500,
      });
      return executable;
    } catch {
      signal.throwIfAborted();
      // Try the next fixed installation path.
    }
  }
  return null;
}

function bundledPiCli(): string | null {
  try {
    const packageDirectory = fs.realpathSync(getPackageDir());
    const candidate = path.join(packageDirectory, "dist", "cli.js");
    const executable = trustedRegularExecutable(candidate);
    if (!executable) return null;
    const relativePath = path.relative(packageDirectory, executable);
    return relativePath && !relativePath.startsWith("..") && !path.isAbsolute(relativePath)
      ? executable
      : null;
  } catch {
    return null;
  }
}

function bundledPiVersion(): string | null {
  // In the packaged build getPackageDir() can resolve into the bundled .next
  // tree, so read the pinned dependency's own package.json from the release
  // root first and only fall back to the SDK's resolution.
  const candidates = [
    path.join(serverPackageRoot(), "node_modules", "@earendil-works", "pi-coding-agent", "package.json"),
    (() => { try { return path.join(fs.realpathSync(getPackageDir()), "package.json"); } catch { return null; } })(),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const version: unknown = (JSON.parse(fs.readFileSync(candidate, "utf8")) as Record<string, unknown>).version;
      if (typeof version === "string" && version.length > 0) return version;
    } catch { /* try the next candidate */ }
  }
  return null;
}

async function windowsServiceRunning(name: string, signal: AbortSignal): Promise<boolean> {
  if (process.platform !== "win32") return false;
  const systemRoot = absoluteWindowsEnvironmentPath("SystemRoot");
  const executable = systemRoot
    ? trustedRegularExecutable(path.win32.join(systemRoot, "System32", "sc.exe"))
    : null;
  if (!executable) return false;
  try {
    return (await runBoundedCommand(executable, ["query", name], {
      environment: COMMAND_ENVIRONMENT,
      outputLimit: 16_384,
      signal,
      timeout: 2000,
    })).stdout.includes("RUNNING");
  } catch {
    signal.throwIfAborted();
    return false;
  }
}

type ServeState = {
  enabled: boolean;
  url: string;
};

async function tailscaleServeState(
  binary: string | null,
  dnsName: string,
  signal: AbortSignal,
): Promise<ServeState> {
  if (!binary) return { enabled: false, url: "" };
  try {
    const raw = (await runBoundedCommand(binary, ["serve", "status", "--json"], {
      environment: COMMAND_ENVIRONMENT,
      outputLimit: 64 * 1024,
      signal,
      timeout: 4000,
    })).stdout;
    const serve = JSON.parse(raw) as {
      TCP?: Record<string, { HTTPS?: boolean }>;
      Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
    };
    const host = dnsName ? `${dnsName}:30141` : "";
    const web = host ? serve.Web?.[host]?.Handlers?.["/"]?.Proxy : undefined;
    const enabled = serve.TCP?.["30141"]?.HTTPS === true && web === "http://127.0.0.1:30141";
    return { enabled, url: enabled && dnsName ? `https://${dnsName}:30141` : "" };
  } catch {
    signal.throwIfAborted();
    return { enabled: false, url: "" };
  }
}

function commandFailureOutput(error: unknown): string {
  if (!(error instanceof BoundedCommandError)) return "External command failed";
  return `${error.stdout}\n${error.stderr}`.trim() || error.message;
}

function approvalUrl(output: string): string | null {
  return output.match(/https:\/\/login\.tailscale\.com\/\S+/)?.[0]?.replace(/[),.;]+$/, "") ?? null;
}

async function status(signal: AbortSignal) {
  const defaultExtensionsPromise = inspectDefaultExtensions(serverPackageRoot());
  const tailscale = await tailscaleBinary(signal);
  let tailnet: Record<string, unknown> | null = null;
  let sshEnabled = false;
  if (tailscale) {
    try {
      tailnet = JSON.parse((await runBoundedCommand(tailscale, ["status", "--json"], {
        environment: COMMAND_ENVIRONMENT,
        outputLimit: 64 * 1024,
        signal,
        timeout: 4000,
      })).stdout) as Record<string, unknown>;
    } catch {
      signal.throwIfAborted();
    }
    try {
      const preferences = JSON.parse((await runBoundedCommand(tailscale, ["debug", "prefs"], {
        environment: COMMAND_ENVIRONMENT,
        outputLimit: 64 * 1024,
        signal,
        timeout: 4000,
      })).stdout) as Record<string, unknown>;
      sshEnabled = preferences.RunSSH === true;
    } catch {
      signal.throwIfAborted();
    }
  }
  const dnsName = String((tailnet?.Self as Record<string, unknown> | undefined)?.DNSName ?? "").replace(/\.$/, "");
  const serve = await tailscaleServeState(tailscale, dnsName, signal);
  const openSshRunning = await windowsServiceRunning("sshd", signal);
  const piInstalled = Boolean(bundledPiCli());
  const providerInstalled = true;
  const serverPackage = packageJsonVersion();
  const defaultExtensions = await defaultExtensionsPromise;
  return {
    platform: {
      os: process.platform,
      remoteAccess: process.platform === "win32" ? "openssh" : "tailscale-ssh",
      openSshRunning,
      terminalBackend: process.platform === "win32" ? "ConPTY" : "PTY",
      preferredShell: process.platform === "win32" ? "PowerShell 7" : (process.env.SHELL || "/bin/sh"),
    },
    tailscale: {
      installed: Boolean(tailscale),
      connected: Boolean(tailnet),
      dnsName,
      sshEnabled,
      sshSupported: process.platform !== "win32",
      serveEnabled: serve.enabled,
      serveUrl: serve.url,
    },
    pi: { installed: piInstalled, version: piInstalled ? bundledPiVersion() : null },
    provider: { installed: providerInstalled, source: "PiHub Server 内置 NewAPI Provider" },
    defaultExtensions,
    server: { installed: serverPackage !== null, packageName: "@pihub/server", version: serverPackage, running: true },
    installPlan: piInstalled ? [] : ["pi"],
    security: { binding: "127.0.0.1", tailnetOnly: true, funnelSupported: false },
  };
}

function serverPackageRoot(): string {
  const configured = process.env.PIHUB_SERVER_ROOT?.trim();
  if (configured && path.isAbsolute(configured) && !/[\0\r\n]/.test(configured)) {
    return path.resolve(configured);
  }
  return process.cwd();
}

function packageJsonVersion(): string | null {
  return process.env.PIHUB_SERVER_VERSION || null;
}

export async function GET(request: NextRequest) {
  const access = requirePihubRouteCapability(request, "system:manage");
  if ("response" in access) return access.response;
  if (!isApiRequestAllowed(request)) {
    return privateRouteJson({ error: "Untrusted API request" }, { status: 403 });
  }
  return privateRouteJson(await status(request.signal));
}

export async function POST(request: NextRequest) {
  const access = requirePihubRouteCapability(request, "system:manage");
  if ("response" in access) return access.response;
  if (!isApiRequestAllowed(request)) {
    return privateRouteJson({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(request)) {
    return privateRouteJson({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  try {
    const body = await readBoundedJsonRequest(request, MAX_SETUP_BODY_BYTES);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return privateRouteJson({ error: "Setup request must be an object" }, { status: 400 });
    }
    const requestBody = body as Record<string, unknown>;
    if (Object.keys(requestBody).length !== 1 || typeof requestBody.action !== "string") {
      return privateRouteJson({ error: "Invalid setup request" }, { status: 400 });
    }
    if (LEGACY_EXTENSION_ACTIONS.has(requestBody.action)) {
      return privateRouteJson({
        error: "Legacy extension setup actions have been removed",
        code: "legacy_extension_action_removed",
        replacement: "Default extensions are managed by the signed PiHub Server release",
      }, { status: 410 });
    }
    if (requestBody.action === "tailscale-serve") {
      const binary = await tailscaleBinary(request.signal); if (!binary) throw new Error("Tailscale not installed");
      try {
        await runBoundedCommand(binary, ["serve", "--bg", "--https=30141", "http://127.0.0.1:30141"], {
          environment: COMMAND_ENVIRONMENT,
          signal: request.signal,
          timeout: 10_000,
        });
      } catch (error) {
        const output = commandFailureOutput(error);
        const url = approvalUrl(output);
        if (url) return privateRouteJson({ success: false, requiresApproval: true, approvalUrl: url, status: await status(request.signal) });
        throw new Error("Unable to enable Tailscale Serve");
      }
      return privateRouteJson({ success: true, status: await status(request.signal) });
    }
    if (requestBody.action === "tailscale-ssh-enable") {
      if (process.platform === "win32") throw new Error("Tailscale SSH Server 不支持 Windows；请使用 Windows OpenSSH Server，并只允许 Tailnet 地址访问");
      const binary = await tailscaleBinary(request.signal); if (!binary) throw new Error("Tailscale not installed");
      await runBoundedCommand(binary, ["set", "--ssh=true"], {
        environment: COMMAND_ENVIRONMENT,
        signal: request.signal,
        timeout: 10_000,
      });
      return privateRouteJson({ success: true, status: await status(request.signal) });
    }
    if (requestBody.action === "provider-install") {
      return privateRouteJson({ success: true, output: "NewAPI Provider 已由 PiHub Server 内置，无需单独安装。", status: await status(request.signal) });
    }
    return privateRouteJson({ error: "Unsupported action" }, { status: 400 });
  } catch (error) {
    if (error instanceof OutboundRequestError) {
      return privateRouteJson({ error: error.message }, { status: error.httpStatus });
    }
    const safeMessages = new Set([
      "Tailscale not installed",
      "Unable to enable Tailscale Serve",
      "Tailscale SSH Server 不支持 Windows；请使用 Windows OpenSSH Server，并只允许 Tailnet 地址访问",
    ]);
    const message = error instanceof Error && safeMessages.has(error.message)
      ? error.message
      : "Unable to complete setup action";
    return privateRouteJson({ error: message }, { status: 400 });
  }
}
