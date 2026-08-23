import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import test from "node:test";
import { assembleRelease } from "./assemble-release.mjs";
import { finalizeDesktopRelease } from "./finalize-desktop-release.mjs";
import { verifyReleaseCandidate } from "./verify-release-candidate.mjs";
import {
  TAURI_UPDATER_PUBLIC_KEY_PATH,
  verifyTauriUpdaterArtifact,
} from "./verify-tauri-updater-signature.mjs";

const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const { createJiti } = require(require.resolve("jiti", { paths: [path.join(root, "server")] }));
const jiti = createJiti(import.meta.url, { interopDefault: true });
const releaseProtocol = await jiti.import(path.join(root, "server", "lib", "release-manifest.ts"));
const { publicKey: serverPublicKey, privateKey: serverPrivateKey } = crypto.generateKeyPairSync("ed25519");
const serverReleaseTrust = releaseProtocol.createReleaseTrust({
  owner: "yourChainGod",
  repo: "pihub",
  channel: "stable",
  publicKey: serverPublicKey,
});
const signedArtifact = "test\n";
const minisignPublicKey = [
  "untrusted comment: minisign public key 60DF2F3B621B4533",
  "RWQzRRtiOy/fYNCli5tW96CO6R+FnO92LceeIoWlCLj+BTVe+6q8T69M",
].join("\n");
const minisignSignature = [
  "untrusted comment: signature from minisign secret key",
  "RWQzRRtiOy/fYEU/vGHUEfBg+lSmrdpViX3l9fX1Ps6FMBrBcsMw9uxsLPFr9pAMdKy1NVEX3MsHsuCKlSVNYc4C5/pCnU/Kugk=",
  "trusted comment: timestamp:1634045550\tfile:test.txt",
  "zEHzYWS0L/lFlN3hfMdAJA0MsVfazBXbwSw9XihxQ0msFQPlC30F6Ajvxi67KEFNd1GUhdi3DcslssTW8MUECQ==",
].join("\n");
const tauriPublicKey = Buffer.from(minisignPublicKey, "utf8").toString("base64");
const tauriSignature = Buffer.from(minisignSignature, "utf8").toString("base64");

function run(script, args, options = {}) {
  return spawnSync(process.execPath, [path.join(root, "scripts", script), ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...options.env },
  });
}

function runTauri(args, options = {}) {
  const command = process.platform === "win32" ? "npx.cmd" : "npx";
  return spawnSync(command, ["--no-install", "tauri", ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...options.env },
  });
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function write(file, contents = "release-fixture\n") {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  return path.resolve(file);
}

function mergeDirectory(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const name of fs.readdirSync(source)) {
    fs.copyFileSync(path.join(source, name), path.join(destination, name), fs.constants.COPYFILE_EXCL);
  }
}

function createTauriSigningKey(directory) {
  const privateKeyPath = path.join(directory, "updater-test.key");
  const password = "pihub-release-test-password";
  const result = runTauri([
    "signer", "generate", "--ci", "--password", password, "--write-keys", privateKeyPath,
  ]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return { privateKeyPath, publicKeyPath: `${privateKeyPath}.pub`, password };
}

function signWithTauri(file, signing) {
  fs.rmSync(`${file}.sig`, { force: true });
  const result = runTauri(["signer", "sign", file], {
    env: {
      TAURI_SIGNING_PRIVATE_KEY_PATH: signing.privateKeyPath,
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: signing.password,
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return path.resolve(`${file}.sig`);
}

function rewriteReleaseChecksums(directory) {
  const names = fs.readdirSync(directory)
    .filter((name) => name !== "RELEASE-SHA256SUMS" && fs.lstatSync(path.join(directory, name)).isFile())
    .sort((left, right) => left.localeCompare(right, "en"));
  write(
    path.join(directory, "RELEASE-SHA256SUMS"),
    `${names.map((name) => `${sha256(path.join(directory, name))}  ${name}`).join("\n")}\n`,
  );
}

function copyCandidate(source, destination) {
  fs.cpSync(source, destination, { recursive: true });
  return destination;
}

function createServerFixtures(server) {
  const serverTargets = [
    ["darwin", "arm64"], ["darwin", "x64"], ["linux", "arm64"],
    ["linux", "x64"], ["win32", "x64"],
  ];
  const assets = [];
  const checksums = new Map();
  for (const [platform, arch] of serverTargets) {
    const base = `pihub-server-0.0.1-${platform}-${arch}`;
    const archiveName = `${base}.tar.gz`;
    const sbomName = `${base}.cdx.json`;
    const archive = write(path.join(server, archiveName), `${platform}/${arch}\n`);
    const sbom = write(path.join(server, sbomName), `${JSON.stringify({ bomFormat: "CycloneDX", components: [] })}\n`);
    write(path.join(server, `${archiveName}.sha256`), `${sha256(archive)}  ${archiveName}\n`);
    write(path.join(server, `${base}.asset.json`), `${JSON.stringify({
      schemaVersion: 1,
      version: "0.0.1",
      platform,
      arch,
      filename: archiveName,
      sha256: sha256(archive),
      size: fs.statSync(archive).size,
      sbom: sbomName,
      sbomSha256: sha256(sbom),
    })}\n`);
    const unsignedAsset = {
      version: "0.0.1",
      platform,
      arch,
      url: `https://github.com/yourChainGod/pihub/releases/download/v0.0.1/${archiveName}`,
      sha256: sha256(archive),
      size: fs.statSync(archive).size,
    };
    assets.push({
      ...unsignedAsset,
      signature: crypto.sign(
        null,
        releaseProtocol.releaseAssetSigningPayload(unsignedAsset),
        serverPrivateKey,
      ).toString("base64url"),
    });
    checksums.set(archiveName, sha256(archive));
    checksums.set(sbomName, sha256(sbom));
  }
  assets.sort((left, right) => `${left.platform}/${left.arch}`.localeCompare(`${right.platform}/${right.arch}`, "en"));
  const unsignedManifest = {
    schemaVersion: releaseProtocol.RELEASE_MANIFEST_SCHEMA_VERSION,
    owner: "yourChainGod",
    repo: "pihub",
    channel: "stable",
    version: "0.0.1",
    assets,
  };
  const manifest = releaseProtocol.canonicalizeReleaseJson({
    ...unsignedManifest,
    signature: crypto.sign(
      null,
      releaseProtocol.releaseManifestSigningPayload(unsignedManifest),
      serverPrivateKey,
    ).toString("base64url"),
  });
  const manifestPath = write(path.join(server, "release-manifest.json"), manifest);
  checksums.set("release-manifest.json", sha256(manifestPath));
  write(
    path.join(server, "SHA256SUMS"),
    `${[...checksums].sort(([left], [right]) => left.localeCompare(right, "en")).map(([name, digest]) => `${digest}  ${name}`).join("\n")}\n`,
  );
  write(path.join(server, "server-release.json"), `${JSON.stringify({
    schemaVersion: 1,
    version: "0.0.1",
    tag: "v0.0.1",
    manifest: "release-manifest.json",
  }, null, 2)}\n`);
}

test("verifies Tauri-compatible Minisign envelopes and rejects invalid trust inputs", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "pihub-updater-signature-test-"));
  try {
    const artifact = write(path.join(temporary, "artifact.tar.gz"), signedArtifact);
    const publicKey = write(path.join(temporary, "updater.pubkey"), `${tauriPublicKey}\n`);
    const signature = write(path.join(temporary, "artifact.tar.gz.sig"), `${tauriSignature}\n`);
    assert.equal(verifyTauriUpdaterArtifact({
      artifactPath: artifact,
      signaturePath: signature,
      publicKeyPath: publicKey,
    }), tauriSignature);

    const modifiedArtifact = write(path.join(temporary, "modified.tar.gz"), "tesu\n");
    assert.throws(() => verifyTauriUpdaterArtifact({
      artifactPath: modifiedArtifact,
      signaturePath: signature,
      publicKeyPath: publicKey,
    }), /signature verification failed/i);

    assert.throws(() => verifyTauriUpdaterArtifact({
      artifactPath: artifact,
      signaturePath: signature,
      publicKeyPath: TAURI_UPDATER_PUBLIC_KEY_PATH,
    }), /signature verification failed/i);

    const truncatedOuter = write(path.join(temporary, "outer-truncated.sig"), tauriSignature.slice(0, -1));
    assert.throws(() => verifyTauriUpdaterArtifact({
      artifactPath: artifact,
      signaturePath: truncatedOuter,
      publicKeyPath: publicKey,
    }), /canonical Base64/i);

    const truncatedMinisign = write(
      path.join(temporary, "minisign-truncated.sig"),
      Buffer.from(minisignSignature.slice(0, -12), "utf8").toString("base64"),
    );
    assert.throws(() => verifyTauriUpdaterArtifact({
      artifactPath: artifact,
      signaturePath: truncatedMinisign,
      publicKeyPath: publicKey,
    }), /not a valid Minisign signature/i);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("Linux collection fails closed when the deb updater signature is absent", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "pihub-deb-signature-test-"));
  try {
    const inputs = path.join(temporary, "inputs");
    const artifactPaths = [
      write(path.join(inputs, "PiHub Desktop_0.0.1_amd64.deb"), signedArtifact),
      write(path.join(inputs, "PiHub Desktop_0.0.1_x86_64.AppImage"), "appimage"),
      write(path.join(inputs, "PiHub Desktop_0.0.1_x86_64.AppImage.tar.gz"), signedArtifact),
      write(path.join(inputs, "PiHub Desktop_0.0.1_x86_64.AppImage.tar.gz.sig"), tauriSignature),
    ];
    const result = run("collect-tauri-release.mjs", [
      "--platform", "linux",
      "--arch", "x86_64",
      "--output", path.join(temporary, "output"),
    ], { env: { PIHUB_TAURI_ARTIFACT_PATHS: JSON.stringify(artifactPaths) } });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /missing \.deb\.sig/i);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("desktop collection rejects files outside the exact target allowlist", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "pihub-desktop-allowlist-test-"));
  try {
    for (const [arch, unexpected] of [["x86_64", "unexpected.exe"], ["aarch64", "unexpected.rpm"]]) {
      const inputs = path.join(temporary, arch);
      const artifactPaths = [
        write(path.join(inputs, `PiHub Desktop_${arch}.AppImage`), "appimage"),
        write(path.join(inputs, `PiHub Desktop_${arch}.deb`), signedArtifact),
        write(path.join(inputs, `PiHub Desktop_${arch}.deb.sig`), tauriSignature),
        write(path.join(inputs, `PiHub Desktop_${arch}.AppImage.tar.gz`), signedArtifact),
        write(path.join(inputs, `PiHub Desktop_${arch}.AppImage.tar.gz.sig`), tauriSignature),
        write(path.join(inputs, unexpected), "not allowed"),
      ];
      const result = run("collect-tauri-release.mjs", [
        "--platform", "linux",
        "--arch", arch,
        "--output", path.join(temporary, `output-${arch}`),
      ], { env: { PIHUB_TAURI_ARTIFACT_PATHS: JSON.stringify(artifactPaths) } });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /unexpected (?:number of files|file)/i);
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("desktop collection rejects a detached signature with the wrong source filename", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "pihub-desktop-signature-pair-test-"));
  try {
    const inputs = path.join(temporary, "inputs");
    const artifactPaths = [
      write(path.join(inputs, "PiHub Desktop_x86_64.AppImage"), "appimage"),
      write(path.join(inputs, "PiHub Desktop_amd64.deb"), signedArtifact),
      write(path.join(inputs, "Detached_amd64.deb.sig"), tauriSignature),
      write(path.join(inputs, "PiHub Desktop_x86_64.AppImage.tar.gz"), signedArtifact),
      write(path.join(inputs, "PiHub Desktop_x86_64.AppImage.tar.gz.sig"), tauriSignature),
    ];
    const result = run("collect-tauri-release.mjs", [
      "--platform", "linux",
      "--arch", "x86_64",
      "--output", path.join(temporary, "output"),
    ], { env: { PIHUB_TAURI_ARTIFACT_PATHS: JSON.stringify(artifactPaths) } });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /signature does not match its updater artifact/i);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("finalizes checksums only after the exact PiHub Desktop manifest bytes pass Minisign verification", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "pihub-manifest-finalize-test-"));
  try {
    const release = path.join(temporary, "release");
    const publicKey = write(path.join(temporary, "updater.pubkey"), tauriPublicKey);
    const manifest = write(path.join(release, "pihub-desktop-v1.json"), signedArtifact);
    const asset = write(path.join(release, "PiHub.AppImage"), "appimage");
    write(path.join(release, "pihub-desktop-v1.json.sig"), tauriSignature);
    write(path.join(release, "RELEASE-SHA256SUMS"), [
      `${sha256(asset)}  PiHub.AppImage`,
      `${sha256(manifest)}  pihub-desktop-v1.json`,
      "",
    ].join("\n"));
    const finalized = finalizeDesktopRelease({
      releaseDirectory: release,
      updaterPublicKeyPath: publicKey,
    });
    assert.equal(
      finalized.get("pihub-desktop-v1.json.sig"),
      sha256(path.join(release, "pihub-desktop-v1.json.sig")),
    );
    assert.match(
      fs.readFileSync(path.join(release, "RELEASE-SHA256SUMS"), "utf8"),
      /[ ]{2}pihub-desktop-v1\.json\.sig\n/,
    );

    fs.appendFileSync(manifest, "changed");
    assert.throws(() => finalizeDesktopRelease({
      releaseDirectory: release,
      updaterPublicKeyPath: publicKey,
    }), /changed after assembly/i);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("collects all desktop targets and assembles verified updater platform entries", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "pihub-release-test-"));
  try {
    const desktop = path.join(temporary, "desktop");
    const signing = createTauriSigningKey(temporary);
    const publicKey = signing.publicKeyPath;
    const targets = [
      {
        platform: "darwin",
        arch: "universal",
        files: [
          ["PiHub Desktop_0.0.1_universal.dmg", "dmg"],
          ["PiHub Desktop_0.0.1_universal.app.tar.gz", signedArtifact],
        ],
      },
      {
        platform: "windows",
        arch: "x86_64",
        files: [
          ["PiHub Desktop_0.0.1_x64-setup.exe", "nsis"],
          ["PiHub Desktop_0.0.1_x64-setup.nsis.zip", signedArtifact],
        ],
      },
      {
        platform: "windows",
        arch: "aarch64",
        files: [
          ["PiHub Desktop_0.0.1_arm64-setup.exe", "nsis"],
          ["PiHub Desktop_0.0.1_arm64-setup.nsis.zip", signedArtifact],
        ],
      },
      {
        platform: "linux",
        arch: "x86_64",
        files: [
          ["PiHub Desktop_0.0.1_amd64.deb", signedArtifact],
          ["PiHub Desktop_0.0.1_x86_64.AppImage", "appimage"],
          ["PiHub Desktop_0.0.1_x86_64.AppImage.tar.gz", signedArtifact],
        ],
      },
      {
        platform: "linux",
        arch: "aarch64",
        files: [
          ["PiHub Desktop_0.0.1_arm64.deb", signedArtifact],
          ["PiHub Desktop_0.0.1_aarch64.AppImage", "appimage"],
          ["PiHub Desktop_0.0.1_aarch64.AppImage.tar.gz", signedArtifact],
        ],
      },
    ];

    for (const target of targets) {
      const inputs = path.join(temporary, `inputs-${target.platform}-${target.arch}`);
      const output = path.join(temporary, `output-${target.platform}-${target.arch}`);
      const artifactPaths = target.files.map(([name, contents]) => write(path.join(inputs, name), contents));
      for (const artifact of [...artifactPaths]) {
        if ([".app.tar.gz", ".nsis.zip", ".deb", ".AppImage.tar.gz"].some((suffix) => artifact.endsWith(suffix))) {
          artifactPaths.push(signWithTauri(artifact, signing));
        }
      }
      const result = run("collect-tauri-release.mjs", [
        "--platform", target.platform,
        "--arch", target.arch,
        "--output", output,
      ], { env: { PIHUB_TAURI_ARTIFACT_PATHS: JSON.stringify(artifactPaths) } });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      mergeDirectory(output, desktop);
    }

    const server = path.join(temporary, "server");
    createServerFixtures(server);
    const output = path.join(temporary, "release");
    assembleRelease({
      desktopDirectory: desktop,
      serverDirectory: server,
      outputDirectory: output,
      repository: "yourChainGod/pihub",
      tag: "v0.0.1",
      pubDate: "2026-08-19T00:00:00Z",
      updaterPublicKeyPath: publicKey,
      serverReleaseTrust,
    });

    const desktopManifestPath = path.join(output, "pihub-desktop-v1.json");
    const latest = JSON.parse(fs.readFileSync(desktopManifestPath, "utf8"));
    assert.equal(latest.version, "0.0.1");
    assert.equal(latest.notes, "PiHub Desktop v0.0.1");
    assert.equal(latest.pub_date, "2026-08-19T00:00:00.000Z");
    assert.equal(latest.pihub.schemaVersion, 1);
    assert.equal(latest.pihub.kind, "pihub.desktop-v1-update-manifest");
    assert.equal(latest.pihub.channel, "desktop-v1-stable");
    assert.equal(latest.pihub.tag, "v0.0.1");
    assert.deepEqual(Object.keys(latest.platforms), [
      "darwin-aarch64",
      "darwin-aarch64-app",
      "darwin-universal",
      "darwin-universal-app",
      "darwin-x86_64",
      "darwin-x86_64-app",
      "linux-aarch64",
      "linux-aarch64-appimage",
      "linux-aarch64-deb",
      "linux-x86_64",
      "linux-x86_64-appimage",
      "linux-x86_64-deb",
      "windows-aarch64",
      "windows-aarch64-nsis",
      "windows-x86_64",
      "windows-x86_64-nsis",
    ]);
    for (const entry of Object.values(latest.platforms)) {
      assert.match(entry.url, /^https:\/\/github\.com\/yourChainGod\/pihub\/releases\/download\/v0\.0\.1\//);
      const name = path.basename(new URL(entry.url).pathname);
      assert.equal(entry.signature, fs.readFileSync(path.join(output, `${name}.sig`), "utf8").trim());
      assert.match(name, /^PiHub-Desktop_0\.0\.1_/);
    }
    assert.deepEqual(Object.keys(latest.pihub.platforms), Object.keys(latest.platforms));
    for (const [key, entry] of Object.entries(latest.platforms)) {
      const name = path.basename(new URL(entry.url).pathname);
      assert.deepEqual(latest.pihub.platforms[key], {
        target: key,
        sha256: sha256(path.join(output, name)),
        size: fs.statSync(path.join(output, name)).size,
      });
    }
    assert.match(latest.platforms["linux-x86_64"].url, /\.AppImage\.tar\.gz$/);
    assert.equal(latest.platforms["linux-x86_64"].url, latest.platforms["linux-x86_64-appimage"].url);
    assert.match(latest.platforms["linux-x86_64-deb"].url, /\.deb$/);
    assert.match(latest.platforms["linux-aarch64"].url, /\.AppImage\.tar\.gz$/);
    assert.match(latest.platforms["linux-aarch64-deb"].url, /\.deb$/);
    assert.match(latest.platforms["windows-aarch64-nsis"].url, /\.nsis\.zip$/);
    signWithTauri(desktopManifestPath, signing);
    finalizeDesktopRelease({ releaseDirectory: output, updaterPublicKeyPath: publicKey });
    const verifyCandidate = (directory) => verifyReleaseCandidate({
      directory,
      repository: "yourChainGod/pihub",
      tag: "v0.0.1",
      updaterPublicKeyPath: publicKey,
      serverReleaseTrust,
    });
    assert.deepEqual(verifyCandidate(output), { version: "0.0.1", assets: 40 });
    for (const line of fs.readFileSync(path.join(output, "RELEASE-SHA256SUMS"), "utf8").trim().split("\n")) {
      const match = line.match(/^([a-f0-9]{64})[ ]{2}([A-Za-z0-9._+-]+)$/);
      assert.ok(match, line);
      assert.equal(sha256(path.join(output, match[2])), match[1]);
    }

    const extraCandidate = copyCandidate(output, path.join(temporary, "candidate-extra"));
    write(path.join(extraCandidate, "unexpected.rpm"), "not reviewed\n");
    rewriteReleaseChecksums(extraCandidate);
    assert.throws(() => verifyCandidate(extraCandidate), /unexpected or unverified asset/i);

    const wrongTargetCandidate = copyCandidate(output, path.join(temporary, "candidate-wrong-target"));
    const wrongTargetManifestPath = path.join(wrongTargetCandidate, "pihub-desktop-v1.json");
    const wrongTargetManifest = JSON.parse(fs.readFileSync(wrongTargetManifestPath, "utf8"));
    wrongTargetManifest.pihub.platforms["windows-aarch64-nsis"].target = "windows-x86_64-nsis";
    write(wrongTargetManifestPath, `${JSON.stringify(wrongTargetManifest, null, 2)}\n`);
    signWithTauri(wrongTargetManifestPath, signing);
    rewriteReleaseChecksums(wrongTargetCandidate);
    assert.throws(() => verifyCandidate(wrongTargetCandidate), /desktop updater integrity mismatch/i);

    const forgedServerCandidate = copyCandidate(output, path.join(temporary, "candidate-forged-server"));
    const forgedManifestPath = path.join(forgedServerCandidate, "release-manifest.json");
    const forgedManifest = JSON.parse(fs.readFileSync(forgedManifestPath, "utf8"));
    forgedManifest.signature = `${forgedManifest.signature[0] === "A" ? "B" : "A"}${forgedManifest.signature.slice(1)}`;
    write(forgedManifestPath, releaseProtocol.canonicalizeReleaseJson(forgedManifest));
    const serverChecksumPath = path.join(forgedServerCandidate, "SHA256SUMS");
    const forgedServerChecksums = fs.readFileSync(serverChecksumPath, "utf8").trim().split("\n").map((line) => (
      line.endsWith("  release-manifest.json")
        ? `${sha256(forgedManifestPath)}  release-manifest.json`
        : line
    ));
    write(serverChecksumPath, `${forgedServerChecksums.join("\n")}\n`);
    rewriteReleaseChecksums(forgedServerCandidate);
    assert.throws(() => verifyCandidate(forgedServerCandidate), /manifest|signature/i);

    const serverManifestPath = path.join(server, "release-manifest.json");
    const serverManifest = fs.readFileSync(serverManifestPath);
    fs.appendFileSync(serverManifestPath, "changed");
    assert.throws(() => assembleRelease({
      desktopDirectory: desktop,
      serverDirectory: server,
      outputDirectory: path.join(temporary, "tampered-server-manifest"),
      repository: "yourChainGod/pihub",
      tag: "v0.0.1",
      pubDate: "2026-08-19T00:00:00Z",
      updaterPublicKeyPath: publicKey,
      serverReleaseTrust,
    }), /(manifest|signature|canonical)/i);
    fs.writeFileSync(serverManifestPath, serverManifest);

    const sidecarPath = path.join(server, "pihub-server-0.0.1-linux-arm64.tar.gz.sha256");
    const sidecar = fs.readFileSync(sidecarPath);
    fs.writeFileSync(sidecarPath, `${"0".repeat(64)}  pihub-server-0.0.1-linux-arm64.tar.gz\n`);
    assert.throws(() => assembleRelease({
      desktopDirectory: desktop,
      serverDirectory: server,
      outputDirectory: path.join(temporary, "tampered-server-sidecar"),
      repository: "yourChainGod/pihub",
      tag: "v0.0.1",
      pubDate: "2026-08-19T00:00:00Z",
      updaterPublicKeyPath: publicKey,
      serverReleaseTrust,
    }), /checksum sidecar/i);
    fs.writeFileSync(sidecarPath, sidecar);

    const tamperedName = "PiHub-Desktop_0.0.1_x86_64.AppImage.tar.gz";
    fs.appendFileSync(path.join(desktop, tamperedName), "tampered");
    assert.throws(() => assembleRelease({
      desktopDirectory: desktop,
      serverDirectory: server,
      outputDirectory: path.join(temporary, "tampered-release"),
      repository: "yourChainGod/pihub",
      tag: "v0.0.1",
      pubDate: "2026-08-19T00:00:00Z",
      updaterPublicKeyPath: publicKey,
      serverReleaseTrust,
    }), /(size|hash) mismatch/i);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("keeps the Minisign verifier pinned outside Server runtime dependencies", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "server", "package.json"), "utf8"));
  const packageLock = JSON.parse(fs.readFileSync(path.join(root, "server", "package-lock.json"), "utf8"));
  assert.equal(packageJson.devDependencies["@threema/wasm-minisign-verify"], "0.2.0-rc.1");
  assert.equal(packageJson.dependencies["@threema/wasm-minisign-verify"], undefined);
  const locked = packageLock.packages["node_modules/@threema/wasm-minisign-verify"];
  assert.equal(locked.version, "0.2.0-rc.1");
  assert.equal(locked.dev, true);
  assert.equal(locked.integrity, "sha512-xGUky5+pcjL7Iq45z7agpJwdxAXYKfT4d+vymc1kheodQ35hMu77lmpNxic7oGhwQAeVKqgMjgX2uvfFIQiFiA==");
});
