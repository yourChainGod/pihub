import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const {
  deleteSessionTransaction,
  SessionRepositoryOwnershipError,
} = await jiti.import("./session-repository.ts");

const OWNER_ID = "owner-a";

function makeDirectory(t) {
  const directoryPath = mkdtempSync(join(tmpdir(), "pihub-session-repository-"));
  t.after(() => rmSync(directoryPath, { force: true, recursive: true }));
  return directoryPath;
}

function sessionBytes(header, body = Buffer.alloc(0), lineEnding = "\n") {
  return Buffer.concat([
    Buffer.from(JSON.stringify({ type: "session", timestamp: "2026-01-01T00:00:00.000Z", ...header })),
    Buffer.from(lineEnding),
    body,
  ]);
}

function readHeaderAndBody(filePath) {
  const contents = readFileSync(filePath);
  const newlineOffset = contents.indexOf(0x0a);
  assert.notEqual(newlineOffset, -1);
  const rawHeader = contents.subarray(0, newlineOffset);
  const headerBytes = rawHeader.at(-1) === 0x0d
    ? rawHeader.subarray(0, rawHeader.length - 1)
    : rawHeader;
  return {
    contents,
    header: JSON.parse(headerBytes.toString("utf8")),
    body: contents.subarray(newlineOffset + 1),
    lineEnding: rawHeader.at(-1) === 0x0d ? "\r\n" : "\n",
  };
}

function repositoryArtifacts(directoryPath) {
  return readdirSync(directoryPath).filter(
    (name) => name.includes(".rewrite-") || name.endsWith(".tombstone"),
  );
}

function baseOptions({ targetId, targetPath, childOwners = new Map(), shutdown, invalidate, io }) {
  return {
    sessionId: targetId,
    filePath: targetPath,
    ownerId: OWNER_ID,
    resolveOwner: async (sessionId) => childOwners.get(sessionId) ?? null,
    shutdownSession: shutdown ?? (() => undefined),
    invalidatePath: invalidate ?? (() => undefined),
    io,
  };
}

test("atomically hides the target and reparents same-owner direct children without changing their bodies", async (t) => {
  const directoryPath = makeDirectory(t);
  const parentPath = join(directoryPath, "grandparent.jsonl");
  const targetPath = join(directoryPath, "target.jsonl");
  const childAPath = join(directoryPath, "child-a.jsonl");
  const childBPath = join(directoryPath, "child-b.jsonl");
  const unrelatedPath = join(directoryPath, "unrelated.jsonl");
  const targetId = "00000000-0000-4000-8000-000000000001";
  const childAId = "00000000-0000-4000-8000-000000000002";
  const childBId = "00000000-0000-4000-8000-000000000003";
  const childABody = Buffer.from([0x7b, 0x00, 0xff, 0x0a, 0x41, 0x42]);
  const childBBody = Buffer.from("{\"type\":\"message\",\"text\":\"keep exactly\"}\n");
  const unrelatedBefore = sessionBytes({ id: "00000000-0000-4000-8000-000000000004" }, Buffer.from("other\n"));
  writeFileSync(targetPath, sessionBytes({ id: targetId, parentSession: parentPath }, Buffer.from("target body\n")));
  writeFileSync(childAPath, sessionBytes({ id: childAId, parentSession: targetPath }, childABody));
  writeFileSync(childBPath, sessionBytes({ id: childBId, parentSession: targetPath }, childBBody, "\r\n"));
  writeFileSync(unrelatedPath, unrelatedBefore);

  const shutdownIds = [];
  const invalidatedIds = [];
  let childRenameCount = 0;
  const result = await deleteSessionTransaction(baseOptions({
    targetId,
    targetPath,
    childOwners: new Map([[childAId, OWNER_ID], [childBId, OWNER_ID]]),
    shutdown: async (sessionId) => shutdownIds.push(sessionId),
    invalidate: (sessionId) => invalidatedIds.push(sessionId),
    io: {
      rename(sourcePath, destinationPath) {
        if (destinationPath === childAPath || destinationPath === childBPath) {
          childRenameCount += 1;
          assert.equal(existsSync(targetPath), false, "target must be hidden before a child is exposed");
          assert.equal(repositoryArtifacts(directoryPath).some((name) => name.endsWith(".tombstone")), true);
        }
        renameSync(sourcePath, destinationPath);
      },
    },
  }));

  assert.equal(existsSync(targetPath), false);
  assert.equal(childRenameCount, 2);
  assert.deepEqual(result.reparentedSessionIds, [childAId, childBId]);
  assert.deepEqual(shutdownIds, [targetId, childAId, childBId]);
  assert.deepEqual(new Set(invalidatedIds), new Set([targetId, childAId, childBId]));
  assert.deepEqual(repositoryArtifacts(directoryPath), []);

  const childA = readHeaderAndBody(childAPath);
  const childB = readHeaderAndBody(childBPath);
  assert.equal(childA.header.parentSession, parentPath);
  assert.equal(childB.header.parentSession, parentPath);
  assert.deepEqual(childA.body, childABody);
  assert.deepEqual(childB.body, childBBody);
  assert.equal(childB.lineEnding, "\r\n");
  assert.deepEqual(readFileSync(unrelatedPath), unrelatedBefore);
});

test("rolls back rewritten children and restores the target when a later child rewrite fails", async (t) => {
  const directoryPath = makeDirectory(t);
  const parentPath = join(directoryPath, "grandparent.jsonl");
  const targetPath = join(directoryPath, "target.jsonl");
  const childAPath = join(directoryPath, "child-a.jsonl");
  const childBPath = join(directoryPath, "child-b.jsonl");
  const targetId = "10000000-0000-4000-8000-000000000001";
  const childAId = "10000000-0000-4000-8000-000000000002";
  const childBId = "10000000-0000-4000-8000-000000000003";
  const targetBefore = sessionBytes({ id: targetId, parentSession: parentPath }, Buffer.from("target\n"));
  const childABefore = sessionBytes({ id: childAId, parentSession: targetPath }, Buffer.from([0x00, 0xff, 0x01]));
  const childBBefore = sessionBytes({ id: childBId, parentSession: targetPath }, Buffer.from("second child\n"));
  writeFileSync(targetPath, targetBefore);
  writeFileSync(childAPath, childABefore);
  writeFileSync(childBPath, childBBefore);

  const invalidatedIds = [];
  let childRenameCount = 0;
  await assert.rejects(
    deleteSessionTransaction(baseOptions({
      targetId,
      targetPath,
      childOwners: new Map([[childAId, OWNER_ID], [childBId, OWNER_ID]]),
      invalidate: (sessionId) => invalidatedIds.push(sessionId),
      io: {
        rename(sourcePath, destinationPath) {
          if (destinationPath === childAPath || destinationPath === childBPath) {
            childRenameCount += 1;
            renameSync(sourcePath, destinationPath);
            if (childRenameCount === 2) throw new Error("injected child rewrite failure");
            return;
          }
          renameSync(sourcePath, destinationPath);
        },
      },
    })),
    /injected child rewrite failure/,
  );

  assert.equal(childRenameCount, 4, "both committed child rewrites should be reversed after the injected failure");
  assert.deepEqual(readFileSync(targetPath), targetBefore);
  assert.deepEqual(readFileSync(childAPath), childABefore);
  assert.deepEqual(readFileSync(childBPath), childBBefore);
  assert.deepEqual(invalidatedIds, []);
  assert.deepEqual(repositoryArtifacts(directoryPath), []);
});

test("rejects a concurrent stat change after shutdown before hiding or rewriting files", async (t) => {
  const directoryPath = makeDirectory(t);
  const targetPath = join(directoryPath, "target.jsonl");
  const childPath = join(directoryPath, "child.jsonl");
  const targetId = "20000000-0000-4000-8000-000000000001";
  const childId = "20000000-0000-4000-8000-000000000002";
  const childBefore = sessionBytes({ id: childId, parentSession: targetPath }, Buffer.from("child\n"));
  writeFileSync(targetPath, sessionBytes({ id: targetId }, Buffer.from("target\n")));
  writeFileSync(childPath, childBefore);

  const invalidatedIds = [];
  await assert.rejects(
    deleteSessionTransaction(baseOptions({
      targetId,
      targetPath,
      childOwners: new Map([[childId, OWNER_ID]]),
      shutdown: async (sessionId) => {
        if (sessionId === targetId) appendFileSync(targetPath, Buffer.from("concurrent append\n"));
      },
      invalidate: (sessionId) => invalidatedIds.push(sessionId),
    })),
    /changed during deletion/,
  );

  assert.equal(existsSync(targetPath), true);
  assert.deepEqual(readFileSync(childPath), childBefore);
  assert.deepEqual(invalidatedIds, []);
  assert.deepEqual(repositoryArtifacts(directoryPath), []);
});

test("fails closed before shutdown when a direct child has a different owner", async (t) => {
  const directoryPath = makeDirectory(t);
  const targetPath = join(directoryPath, "target.jsonl");
  const childPath = join(directoryPath, "child.jsonl");
  const targetId = "30000000-0000-4000-8000-000000000001";
  const childId = "30000000-0000-4000-8000-000000000002";
  const targetBefore = sessionBytes({ id: targetId }, Buffer.from("target\n"));
  const childBefore = sessionBytes({ id: childId, parentSession: targetPath }, Buffer.from("child\n"));
  writeFileSync(targetPath, targetBefore);
  writeFileSync(childPath, childBefore);
  const shutdownIds = [];

  await assert.rejects(
    deleteSessionTransaction(baseOptions({
      targetId,
      targetPath,
      childOwners: new Map([[childId, "owner-b"]]),
      shutdown: async (sessionId) => shutdownIds.push(sessionId),
    })),
    SessionRepositoryOwnershipError,
  );

  assert.deepEqual(shutdownIds, []);
  assert.deepEqual(readFileSync(targetPath), targetBefore);
  assert.deepEqual(readFileSync(childPath), childBefore);
});

test("treats a target removed by shutdown as a successful transient deletion", async (t) => {
  const directoryPath = makeDirectory(t);
  const targetPath = join(directoryPath, "target.jsonl");
  const targetId = "40000000-0000-4000-8000-000000000001";
  writeFileSync(targetPath, sessionBytes({ id: targetId }));
  const invalidatedIds = [];

  const result = await deleteSessionTransaction(baseOptions({
    targetId,
    targetPath,
    shutdown: async () => unlinkSync(targetPath),
    invalidate: (sessionId) => invalidatedIds.push(sessionId),
  }));

  assert.deepEqual(result, { reparentedSessionIds: [] });
  assert.equal(existsSync(targetPath), false);
  assert.deepEqual(invalidatedIds, [targetId]);
  assert.deepEqual(repositoryArtifacts(directoryPath), []);
});
