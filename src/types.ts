export type DeviceSource = "tailscale" | "manual";

export interface Device {
  id: string;
  name: string;
  host: string;
  url: string;
  source: DeviceSource;
  favorite: boolean;
  accent: string;
  os?: string;
  /** Stable Tailscale CGNAT/IPv6 address; survives machine renames. */
  ip?: string;
}

export interface DeviceStatus {
  state: "online" | "auth" | "offline" | "checking";
  latencyMs?: number;
  version?: string;
  error?: string;
}

export interface DeviceCredentialStatus {
  paired: boolean;
  deviceId?: string;
}

export interface TailnetPeer {
  id: string;
  name: string;
  host: string;
  dnsName?: string;
  ip: string;
  os?: string;
  online: boolean;
  isSelf: boolean;
  piWeb: boolean;
  requiresAuth: boolean;
  url: string;
  latencyMs?: number;
  version?: string;
  setup?: RemoteSetupStatus;
}

export interface TailnetScan {
  available: boolean;
  tailnet?: string;
  peers: TailnetPeer[];
  message?: string;
}

export interface RemoteSession {
  id: string;
  cwd: string;
  name?: string;
  created: string;
  modified: string;
  messageCount: number;
  firstMessage: string;
  projectRoot?: string;
  projectKey?: string;
  worktreeBranch?: string;
  transient?: boolean;
  /** Last run was cut short (e.g. server restart); the turn never completed. */
  interrupted?: boolean;
}

export interface SessionMessage {
  role: "user" | "assistant" | "toolResult" | string;
  content: unknown;
  timestamp?: number;
  [key: string]: unknown;
}

export interface RemoteDirectoryEntry { name: string; path: string; }
export interface RemoteDirectoryBrowse {
  path: string;
  parentPath: string | null;
  directories: RemoteDirectoryEntry[];
  drives?: RemoteDirectoryEntry[];
}

export interface SessionTreeNode {
  entry: { id: string; type: string; [key: string]: unknown };
  children: SessionTreeNode[];
  label?: string;
  compressedEntryIds?: string[];
  branchPreview?: { role?: "user" | "assistant"; text: string };
}

export interface BranchLeaf {
  id: string;
  label: string;
  active: boolean;
}

export interface SessionDetail {
  sessionId: string;
  filePath?: string;
  leafId?: string | null;
  tree?: SessionTreeNode[];
  /** Flat branch-leaf list; newer servers send this instead of the full tree. */
  branches?: BranchLeaf[];
  info: RemoteSession | null;
  context: {
    messages: SessionMessage[];
    entryIds: string[];
    thinkingLevel: string;
    model: { provider: string; modelId: string } | null;
    truncated?: boolean;
    totalMessages?: number;
    /** Server answered an `after` cursor: messages holds only newer entries. */
    incremental?: boolean;
    /** The cursor was lost (compaction/rewrite): messages are a fresh window. */
    reset?: boolean;
  };
  totalActiveMs: number;
}

export interface RemoteUiRequest {
  id: string;
  method: "select" | "confirm" | "input" | "editor" | "notify" | "setWidget" | "setTitle" | "set_editor_text" | string;
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  notifyType?: "info" | "warning" | "error";
  /** custom: headless-rendered TUI lines for an extension's custom UI. */
  lines?: string[];
  /** custom: the extension closed this UI; remove the card. */
  closed?: boolean;
  /** setWidget: widget identity; widgetLines === undefined clears the widget. */
  widgetKey?: string;
  widgetLines?: string[];
  widgetPlacement?: "aboveEditor" | "belowEditor";
  /** set_editor_text: text the extension wants in the composer. */
  text?: string;
  /** ask: pi-ask structured flow (native panel); only flowId is set on close. */
  ask?: RemoteAskFlow;
  /** ask: the previous submit was rejected; the panel reopens with this note. */
  error?: string;
}

export interface RemoteWidgetItem {
  key: string;
  lines: string[];
  placement?: "aboveEditor" | "belowEditor";
}

/** pi-ask structured ask flow bridged from the extension event bus. */
export interface RemoteAskOption {
  value: string;
  label: string;
  description?: string;
  preview?: string;
  recommended?: boolean;
  freeform?: boolean;
}

export interface RemoteAskQuestion {
  id: string;
  label: string;
  prompt: string;
  type: "single" | "multi" | "preview";
  presentedType?: "single" | "multi" | "preview";
  required: boolean;
  options: RemoteAskOption[];
}

export interface RemoteAskFlow {
  flowId: string;
  title?: string;
  source?: string;
  questions?: RemoteAskQuestion[];
}

export type RemoteAskAnswer = {
  values?: string[];
  customText?: string;
  note?: string;
};

export type RemoteAskResponse =
  | { kind: "answer"; answers: Record<string, RemoteAskAnswer>; mode?: "submit" | "elaborate" }
  | { kind: "cancel" };

export interface RemoteContextUsage {
  percent: number | null;
  contextWindow: number;
  tokens: number | null;
}

export interface RemoteAgentState {
  running: boolean;
  state?: {
    isStreaming?: boolean;
    isCompacting?: boolean;
    thinkingLevel?: string;
    model?: { id: string; provider: string };
    contextUsage?: RemoteContextUsage | null;
    systemPrompt?: string;
    extensionWidgets?: RemoteWidgetItem[];
  };
}

export interface RemoteAgentEventPayload {
  deviceId: string;
  deviceOrigin: string;
  sessionId: string;
  generation: number;
  event: Record<string, unknown>;
}

export interface RemoteTerminalEventPayload {
  deviceId: string;
  deviceOrigin: string;
  terminalId: string;
  generation: number;
  event: { type: string; data?: string; reason?: string };
}

export interface AttachedImage {
  data: string;
  mimeType: string;
  name: string;
}

export interface SessionTokenStats {
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  cost: number;
}

export interface RemoteModelEntry { id: string; name: string; provider: string }
export interface RemoteModelsResponse {
  models: Record<string, string>;
  modelList: RemoteModelEntry[];
  defaultModel: { provider: string; modelId: string } | null;
  thinkingLevels: Record<string, string[]>;
  thinkingLevelMaps?: Record<string, Record<string, string | null>>;
  thinkingLevelPins?: Record<string, string>;
  modelError?: string;
  modelScopeWarnings?: string[];
}

export interface RemoteNewApiProvider {
  name: string;
  baseUrl: string;
  authenticated: boolean;
  overrideCount: number;
}

export interface RemoteNewApiConfig {
  providers: RemoteNewApiProvider[];
  settings: { sendSessionAffinityHeaders: boolean };
  modelCount?: number;
}

export interface RemoteGitStatus {
  isGitRepository: boolean;
  isBareRepository?: boolean;
  repositoryRoot: string | null;
  files: Array<{
    filePath: string;
    status: string;
    code?: string;
    indexStatus?: string;
    worktreeStatus?: string;
  }>;
  additions: number;
  deletions: number;
}

export interface RemoteGitDiff {
  supported: boolean;
  status?: string;
  patch?: string;
}

export interface RemoteWorktree {
  path: string;
  branch: string | null;
  isMain: boolean;
}

export interface RemoteWorktrees {
  projectRoot: string;
  projectKey: string;
  isGit: boolean;
  isTopLevel: boolean;
  currentWorktreePath: string | null;
  worktrees: RemoteWorktree[];
}

export interface RemoteProjectTrustStatus {
  requiresTrust: boolean;
  trusted: boolean;
}

export type RemoteResourceScope = "global" | "project";

export interface RemoteResourceDiagnostic {
  type: "warning" | "error";
  code?: string;
  message: string;
  source?: string;
  path?: string;
}

export interface RemoteSkillInstallInfo {
  package: string;
  scope: RemoteResourceScope;
  source: string;
  sourceType?: string;
  skillsShUrl?: string;
  skillPath?: string;
  ref?: string;
  versionHash?: string;
  canCheckForUpdates: boolean;
}

export interface RemoteSkillInfo {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  disableModelInvocation: boolean;
  sourceInfo: {
    source?: string;
    scope?: string;
  };
  install?: RemoteSkillInstallInfo;
}

export interface RemoteSkillsResponse {
  skills: RemoteSkillInfo[];
  diagnostics: RemoteResourceDiagnostic[];
  projectResourcesLoaded: boolean;
}

export interface RemotePluginResourceCounts {
  extensions: number;
  skills: number;
  prompts: number;
  themes: number;
}

export interface RemotePluginPackageInfo {
  id: string;
  label: string;
  scope: RemoteResourceScope;
  disabled: boolean;
  version?: string;
  counts: RemotePluginResourceCounts;
  status: "loaded" | "installed" | "missing" | "disabled";
}

export interface RemotePluginsResponse {
  packages: RemotePluginPackageInfo[];
  totals: RemotePluginResourceCounts;
  diagnostics: RemoteResourceDiagnostic[];
  projectResourcesLoaded: boolean;
}

export interface RemoteFilePreview {
  content: string;
  language: string;
  size: number;
}

export interface RemoteDirectoryListing {
  path: string;
  entries: Array<{ name: string; isDir: boolean; size: number; modified: string }>;
}

export interface NewRemoteSession {
  success: boolean;
  sessionId: string;
  model: { provider: string; modelId: string } | null;
  thinkingLevel?: string;
}

export interface RemoteSetupStatus {
  platform?: { os: string; remoteAccess: "tailscale-ssh" | "openssh"; openSshRunning: boolean; terminalBackend: string; preferredShell: string };
  tailscale: { installed: boolean; connected: boolean; dnsName: string; sshEnabled: boolean; sshSupported?: boolean; serveEnabled: boolean; serveUrl: string };
  pi: { installed: boolean; version?: string | null };
  provider?: { installed: boolean; source: string };
  defaultExtensions: {
    installed: boolean;
    installedCount: number;
    total: number;
    source: "signed-release";
    packages: Array<{ name: string; version: string; installed: boolean; installedVersion?: string | null }>;
    magicContext: {
      installed: boolean;
      configured: boolean;
      todoEnabled: boolean;
      todoOverlay: boolean;
      compactionEnabled: boolean;
      agentsManaged: boolean;
      version: string;
      source: "signed-release";
    };
  };
  server?: { installed: boolean; packageName: string; version: string | null; running: boolean };
  installPlan?: string[];
  security: { binding: string; tailnetOnly: boolean; funnelSupported: boolean };
}

export type RemoteServerUpdatePhase =
  | "idle"
  | "recovering"
  | "queued"
  | "applying"
  | "restarting"
  | "succeeded"
  | "failed";

export interface RemoteServerUpdateState {
  phase: RemoteServerUpdatePhase;
  operationId?: string;
  targetVersion?: string;
  resultVersion?: string;
  errorCode?: string;
  updatedAt: string;
}

export interface RemoteUpdates {
  server: {
    current: string | null;
    latest: string;
    updateAvailable: boolean;
    platform: "darwin" | "linux" | "win32";
    arch: "arm64" | "x64";
    channel: "stable";
  };
  installSupported: boolean;
  update: RemoteServerUpdateState | null;
  running: string[];
  checkedAt: string;
}

export interface RemoteServerUpdateAccepted {
  accepted: true;
  operationId: string;
  update: RemoteServerUpdateState & { phase: "queued"; operationId: string };
}

/** Per-layer component versions reported by GET /api/pihub/components. */
export interface RemoteComponents {
  server: {
    current: string;
    mode: "ipc" | "legacy";
  };
  pi: {
    current: string | null;
    available: boolean;
    binary: string | null;
  };
  extensions: {
    items: Array<{ name: string; version: string }>;
    count: number;
    managedBy: "pi";
  };
  checkedAt: string;
}

/** POST /api/pihub/components starts a background job and returns its id. */
export interface RemoteComponentUpdateAccepted {
  accepted: true;
  jobId: string;
}

export type RemoteComponentJobStatus = "running" | "done" | "failed";

export interface RemoteComponentJob {
  status: RemoteComponentJobStatus;
  output: string;
  startedAt: string;
  finishedAt?: string;
}

/**
 * A todo owned by the pi-todo-rail extension. Ids are per-session and
 * branch-aware; the list lives in the session transcript, not a side file.
 */
export interface RailTodo {
  id: number;
  text: string;
  done: boolean;
  note?: string;
}

export interface RailSnapshot {
  version: 2;
  todos: RailTodo[];
  nextId: number;
}

/** GET /api/pihub/todos */
export interface RemoteTodosResponse {
  snapshot: RailSnapshot;
  readAt: string;
}

/** A permission rule. `pi-native` scope means it came from Pi and is read-only. */
export interface RemotePermissionRule {
  pattern: string;
  action: "allow" | "deny" | "ask";
  scope?: string;
}

/** GET/POST/DELETE /api/pihub/permissions */
export interface RemotePermissionsResponse {
  rules: RemotePermissionRule[];
  readAt?: string;
}

export type RemoteSubagentStatus = "running" | "completed" | "failed" | "aborted";

export interface RemoteSubagent {
  id: string;
  name: string;
  status: RemoteSubagentStatus;
  startedAt?: string;
  finishedAt?: string;
  description?: string;
  error?: string;
}

/** GET /api/pihub/subagents — polled by the client. */
export interface RemoteSubagentsResponse {
  subagents: RemoteSubagent[];
  activeCount: number;
  totalCount: number;
  readAt: string;
}
