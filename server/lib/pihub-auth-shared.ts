export const PIHUB_CAPABILITIES = [
  "agents:use",
  "sessions:read",
  "sessions:write",
  "files:read",
  "files:write",
  "workspaces:read",
  "workspaces:manage",
  "models:read",
  "models:manage",
  "providers:manage",
  "packages:read",
  "packages:manage",
  "terminal:use",
  "system:manage",
  "system:update",
  "devices:manage",
] as const;

export type PihubCapability = (typeof PIHUB_CAPABILITIES)[number];

const CAPABILITY_SET = new Set<string>(PIHUB_CAPABILITIES);

export class PihubAuthInputError extends Error {
  constructor(message = "Invalid authentication input") {
    super(message);
    this.name = "PihubAuthInputError";
  }
}

export function isPihubCapability(value: unknown): value is PihubCapability {
  return typeof value === "string" && CAPABILITY_SET.has(value);
}

export function normalizePihubCapabilities(
  value: unknown,
): PihubCapability[] {
  const source = value;
  if (!Array.isArray(source) || source.length === 0) {
    throw new PihubAuthInputError("At least one capability is required");
  }

  const capabilities = [...new Set(source)];
  if (capabilities.length > PIHUB_CAPABILITIES.length || !capabilities.every(isPihubCapability)) {
    throw new PihubAuthInputError("Invalid capability set");
  }

  return PIHUB_CAPABILITIES.filter((capability) => capabilities.includes(capability));
}

export function normalizePihubDeviceLabel(value: unknown): string {
  if (value === undefined) return "PiHub device";
  if (typeof value !== "string") throw new PihubAuthInputError("Invalid device label");

  const label = value.trim();
  if (!label || label.length > 80 || /[\u0000-\u001f\u007f]/.test(label)) {
    throw new PihubAuthInputError("Invalid device label");
  }
  return label;
}
