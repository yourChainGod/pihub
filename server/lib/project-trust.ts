import { hasTrustRequiringProjectResources, ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import type { ProjectTrustStatus } from "./api-types";
import { inspectGitExecutionRisk } from "./git-command";

export function getProjectTrustStatus(cwd: string, agentDir: string): ProjectTrustStatus {
  const requiresTrust = Boolean(cwd) && hasTrustRequiringProjectResources(cwd);
  if (!requiresTrust) return { requiresTrust: false, trusted: true };

  const trustStore = new ProjectTrustStore(agentDir);
  return {
    requiresTrust: true,
    trusted: trustStore.get(cwd) === true,
  };
}

export function trustProject(cwd: string, agentDir: string): ProjectTrustStatus {
  const status = getProjectTrustStatus(cwd, agentDir);
  if (!status.requiresTrust) return status;

  new ProjectTrustStore(agentDir).set(cwd, true);
  return { requiresTrust: true, trusted: true };
}

/**
 * Worktree changes mutate checkout state and can consult repository-local Git
 * metadata. Every Git repository therefore requires an explicit operation
 * trust decision. Executable drivers remain disabled even after trust.
 */
export async function getProjectOperationTrustStatus(
  cwd: string,
  agentDir: string,
): Promise<ProjectTrustStatus> {
  const resourceStatus = getProjectTrustStatus(cwd, agentDir);
  let gitRequiresTrust = false;
  try {
    const gitRisk = await inspectGitExecutionRisk(cwd);
    gitRequiresTrust = gitRisk.isRepository || gitRisk.requiresTrust;
  } catch {
    // Ambiguous or malformed Git metadata must not bypass the mutation gate.
    gitRequiresTrust = true;
  }
  const requiresTrust = resourceStatus.requiresTrust || gitRequiresTrust;
  if (!requiresTrust) return { requiresTrust: false, trusted: true };
  return {
    requiresTrust: true,
    trusted: new ProjectTrustStore(agentDir).get(cwd) === true,
  };
}

export function trustProjectOperation(cwd: string, agentDir: string): ProjectTrustStatus {
  new ProjectTrustStore(agentDir).set(cwd, true);
  return { requiresTrust: true, trusted: true };
}

/**
 * Reload options that gate project-local, trust-requiring resources — a
 * repository's `.pi/extensions`, project `.pi/settings.json` extension
 * entries, and `.agents/skills` — behind the SDK's project-trust store.
 *
 * Pi Web *executes* project extensions when it builds session services: their
 * factory runs on import and their `session_start` handlers run on startup.
 * Without a trust gate, merely opening an untrusted repository in Pi Web runs
 * repository-controlled code locally (issue #236). The SDK's resource loader
 * only imports project extensions once `resolveProjectTrust` resolves true, so
 * denying trust keeps them dormant.
 *
 * Pi Web and the `pi` CLI share the same trust store. Projects with gated
 * resources default to untrusted until either client records a trust decision.
 * Returns `undefined` when the project has no trust-requiring resources,
 * leaving ordinary projects on their existing load path.
 */
export function projectTrustReloadOptions(
  cwd: string,
  agentDir: string,
): { resolveProjectTrust: () => Promise<boolean> } | undefined {
  const status = getProjectTrustStatus(cwd, agentDir);
  if (!status.requiresTrust) return undefined;
  const trustStore = new ProjectTrustStore(agentDir);
  return { resolveProjectTrust: async () => trustStore.get(cwd) === true };
}
