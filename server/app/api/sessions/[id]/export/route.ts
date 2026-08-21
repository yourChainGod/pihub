import { randomUUID } from "crypto";
import { mkdirSync, realpathSync, rmSync } from "fs";
import { readFile } from "fs/promises";
import { tmpdir } from "os";
import { basename, join, relative } from "path";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { runBoundedCommand } from "@/lib/bounded-command";
import { createMinimalProcessEnvironment } from "@/lib/process-environment";
import { resolveSessionPath } from "@/lib/session-reader";
import { pihubNoStoreHeaders } from "@/lib/pihub-auth-http";
import { privateSessionJson, requireOwnedSession } from "@/lib/session-access";
import { trustedRegularExecutable } from "@/lib/trusted-executables";

export const runtime = "nodejs";

function encodeHeaderValue(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (ch) =>
    `%${ch.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function getContentDisposition(fileName: string, inline: boolean): string {
  const fallback = fileName.replace(/[^\x20-\x7E]|["\\;\r\n]/g, "_") || "session.html";
  const disposition = inline ? "inline" : "attachment";
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encodeHeaderValue(fileName)}`;
}

function getPiCliPath(): string | null {
  try {
    const packageDir = realpathSync(getPackageDir());
    const executable = trustedRegularExecutable(join(packageDir, "dist", "cli.js"));
    if (!executable) return null;
    const fromPackage = relative(packageDir, executable);
    return fromPackage && !fromPackage.startsWith("..") ? executable : null;
  } catch {
    return null;
  }
}

/**
 * Patch the exported HTML to fix recursive functions that overflow
 * the call stack on deep linear session trees (e.g., 5000+ entries).
 *
 * ## Root Cause
 * pi-coding-agent's template.js uses recursive helpers to render and
 * navigate the session tree in the exported HTML:
 *
 *   1. sortChildren(node) — recursively sorts children of every node.
 *      Calls itself via node.children.forEach(sortChildren).
 *      On a 5527-entry linear chain (no branches), this recurses 5527
 *      levels deep → stack overflow.
 *
 *   2. mapNodes(node) — recursively indexes tree nodes the first time
 *      a tree item is clicked. Same depth -> same overflow.
 *
 *   3. markActive(node) — recursively marks nodes on the active path.
 *      Calls itself via markActive(child) for each child.
 *      Same depth → same overflow.
 *
 * Both functions are inlined in the HTML by pi-coding-agent at export
 * time. We cannot modify template.js directly (it's in node_modules
 * and would be overwritten on npm install). Instead, we patch the
 * generated HTML string before returning it to the client.
 *
 * ## Fix
 * Replace each recursive function with an iterative equivalent:
 *
 *   sortChildren  → explicit stack (DFS pre-order, push children in
 *                   reverse to maintain order)
 *   mapNodes      → explicit stack (DFS pre-order)
 *   markActive    → two-stack post-order (stack1 for traversal,
 *                   stack2 for processing children before parent)
 *
 * ## Line Ending Normalization
 * This file (route.ts) uses CRLF (Windows), while template.js uses LF
 * (Unix). The template strings in the backtick literals inherit the
 * file's CRLF line endings. At runtime, readFileSync() also returns
 * CRLF on Windows. We normalize everything to LF before matching.
 *
 * The helper `n(s)` strips \r\n → \n on both the HTML and the
 * replacement strings, ensuring cross-platform matching.
 */
function patchExportHtml(html: string): string {
  // Normalize line endings: route.ts is CRLF, template.js is LF.
  // Without this, the replace() below would fail on Windows.
  const n = (s: string) => s.replace(/\r\n/g, "\n");
  html = n(html);

  const replaceRequired = (source: string, name: string, search: string, replacement: string) => {
    const normalizedSearch = n(search);
    const normalizedReplacement = n(replacement);
    const matches = source.split(normalizedSearch).length - 1;
    if (matches !== 1) {
      throw new Error(`Failed to patch exported HTML: ${name} expected 1 match, found ${matches}`);
    }
    return source.replace(normalizedSearch, normalizedReplacement);
  };

  html = replaceRequired(
    html,
    "sortChildren",
    `        function sortChildren(node) {
          node.children.sort((a, b) =>
            new Date(a.entry.timestamp).getTime() - new Date(b.entry.timestamp).getTime()
          );
          node.children.forEach(sortChildren);
        }`,
    `        function sortChildren(root) {
          const stack = [root];
          while (stack.length) {
            const node = stack.pop();
            node.children.sort((a, b) =>
              new Date(a.entry.timestamp).getTime() - new Date(b.entry.timestamp).getTime()
            );
            for (let i = node.children.length - 1; i >= 0; i--) {
              stack.push(node.children[i]);
            }
          }
        }`
  );

  html = replaceRequired(
    html,
    "mapNodes",
    `          function mapNodes(node) {
            treeNodeMap.set(node.entry.id, node);
            node.children.forEach(mapNodes);
          }
          tree.forEach(mapNodes);`,
    `          const stack = [...tree].reverse();
          while (stack.length) {
            const node = stack.pop();
            treeNodeMap.set(node.entry.id, node);
            for (let i = node.children.length - 1; i >= 0; i--) {
              stack.push(node.children[i]);
            }
          }`
  );

  html = replaceRequired(
    html,
    "markActive",
    `        function markActive(node) {
          let has = activePathIds.has(node.entry.id);
          for (const child of node.children) {
            if (markActive(child)) has = true;
          }
          containsActive.set(node, has);
          return has;
        }`,
    `        function markActive(root) {
          // Post-order traversal using two stacks
          const stack1 = [root];
          const stack2 = [];
          while (stack1.length) {
            const node = stack1.pop();
            stack2.push(node);
            for (const child of node.children) {
              stack1.push(child);
            }
          }
          while (stack2.length) {
            const node = stack2.pop();
            let has = activePathIds.has(node.entry.id);
            for (const child of node.children) {
              if (containsActive.get(child)) has = true;
            }
            containsActive.set(node, has);
          }
        }`
  );

  return html;
}

async function exportSession(
  filePath: string,
  outputPath: string,
  signal: AbortSignal,
): Promise<void> {
  const cliPath = getPiCliPath();
  if (!cliPath) throw new Error("pi CLI not found");
  await runBoundedCommand(process.execPath, [cliPath, "--export", filePath, outputPath], {
    cwd: getPackageDir(),
    timeout: 30_000,
    environment: createMinimalProcessEnvironment(process.env, {
      additionalAllowedKeys: ["PI_OFFLINE", "PI_SKIP_VERSION_CHECK"],
      overrides: {
        PI_OFFLINE: "1",
        PI_SKIP_VERSION_CHECK: "1",
      },
    }),
    outputLimit: 64 * 1024,
    signal,
  });
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const access = requireOwnedSession(req, id, "sessions:read");
  if ("response" in access) return access.response;
  const inline = new URL(req.url).searchParams.get("inline") === "1";

  try {
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return privateSessionJson({ error: "Session not found" }, { status: 404 });
    }

    const tempDir = join(tmpdir(), "pi-web-export");
    mkdirSync(tempDir, { recursive: true });

    const sessionBase = basename(filePath, ".jsonl");
    const fileName = `pi-session-${sessionBase}.html`;
    const outputPath = join(tempDir, `${randomUUID()}.html`);

    try {
      await exportSession(filePath, outputPath, req.signal);

      const html = await readFile(outputPath, "utf8");
      const patchedHtml = patchExportHtml(html);
      return new Response(patchedHtml, {
        headers: pihubNoStoreHeaders({
          "Content-Type": "text/html; charset=utf-8",
          "Content-Disposition": getContentDisposition(fileName, inline),
          "Content-Security-Policy": "sandbox allow-scripts allow-downloads; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
          "Cross-Origin-Opener-Policy": "same-origin",
          "Cross-Origin-Resource-Policy": "same-origin",
          "Referrer-Policy": "no-referrer",
          "X-Content-Type-Options": "nosniff",
          "X-Frame-Options": "DENY",
        }),
      });
    } finally {
      rmSync(outputPath, { force: true });
    }
  } catch {
    return privateSessionJson({ error: "Failed to export session" }, { status: 500 });
  }
}
