# Require a signed immutable catalog for remote package mutations

Status: Accepted for `0.0.1`

## Context

PiHub Server can load plugins and skills already configured on the host, while paired desktop clients can inspect and enable or disable those exact entries. The upstream Pi package manager also supports npm and Git installation, update, and removal. Exposing those mutators through a remote API would let a compromised device select executable code, follow mutable refs, invoke package lifecycle scripts, and cross the product boundary that device data remains under the Server owner's control.

Update metadata is less privileged than package mutation, but it is still an outbound request surface. Caller-selected origins, redirects, DNS rebinding, unbounded responses, or Git/npm subprocess fallbacks would turn a read-only check into an SSRF, resource-exhaustion, or credential-leak path.

## Decision

For `0.0.1`, remote skill install and update and remote plugin install, update, and removal fail closed with HTTP `410` and `code: signed_catalog_required`. Authentication and the `packages:manage` capability are checked before that response so the disabled endpoints do not become public route exceptions.

Remote plugin enable and disable may only mutate one exact source already present in the selected global or trusted-project settings file. Clients receive a scope-bound opaque package handle and a sanitized display label, never the configured source, installed path, resource paths, or filter body. The mutation is bounded, locked, symlink-rejecting, and atomically published. Disable preserves the complete original entry so enable restores the same filters instead of broadening the executable resource set. Ambiguous sources and legacy disabled entries without restorable state fail closed.

Skill search and update checks are informational only. They use compile-time fixed HTTPS origins, the shared secure outbound transport, no redirects, bounded JSON schemas and bodies, DNS/IP policy, deadlines, idle timeouts, and request cancellation. They never invoke npm, npx, Git, or an SDK package mutator. An update is reported only from an immutable content hash; it is not applied.

## Security invariants

1. No remotely supplied package source reaches npm, npx, Git, a shell, or `DefaultPackageManager` mutation methods.
2. No environment variable or request field can replace the approved catalog origins.
3. A read/list/check operation cannot install a missing package. Plugin resolution must return `skip` for every missing source.
4. A package settings mutation cannot add, remove, rename, or broaden an entry; it can only disable or exactly restore one configured source selected by its scope-bound opaque handle.
5. Project package state cannot be read as executable project resources or mutated until the project trust gate succeeds.
6. Authentication, device ownership, capability, body, filesystem, outbound-network, cancellation, and response-cache checks remain explicit at the route boundary.

## Re-enabling package installation

Remote mutation may be reconsidered only after a catalog and installer prove all of the following as one release-gated design:

- the catalog is signed by a compile-time pinned key and identifies immutable package bytes by SHA-256;
- package identity, version, platform, architecture, size, dependency graph, and allowed executable resources are covered by the signature;
- assets come from fixed origins without redirects and are staged privately with archive traversal, link, collision, count, size, and compression-ratio checks;
- dependency resolution is reproducible from a dedicated lock or signed offline bundle, with lifecycle scripts disabled unless individually reviewed and declared;
- activation is atomic, cancellable before publication, journaled, health-checked, and reversible;
- the desktop UI presents signer, version, scope, permissions, and confirmation before mutation; and
- negative authentication, forgery, replay, SSRF, tamper, rollback, interruption, and cross-platform tests pass in CI.

Until every condition is implemented and verified, the structured `410` response is a release invariant rather than a temporary availability fallback.

## Verification

The route and invariant checks live in `server/app/api/subprocess-supply-chain.test.mjs`; catalog transport and schema checks live in `server/lib/skills-catalog.test.mjs` and `server/lib/skill-updates.test.mjs`; exact atomic settings mutation checks live in `server/lib/package-settings-security.test.mjs`. The production Server test command includes all of them.
