#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const iconDirectory = path.join(projectRoot, "src-tauri", "icons");
const sourcePath = path.join(iconDirectory, "app-icon.svg");
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const PI_PATH =
  "M430 422c0-10 8-18 18-18h164v42h-30v102c0 28 13 45 40 51v42c-56-4-84-36-84-92V446h-48v170h-46V446h-32v-24h18Z";

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function filesBelow(directory, prefix = "") {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) {
      result.push(...(await filesBelow(path.join(directory, entry.name), relative)));
    } else if (entry.isFile()) {
      result.push(relative);
    }
  }
  return result.sort();
}

function parseIcns(buffer) {
  assert.equal(buffer.subarray(0, 4).toString("ascii"), "icns", "invalid ICNS magic");
  assert.equal(buffer.readUInt32BE(4), buffer.length, "invalid ICNS length");
  const chunks = [];
  for (let offset = 8; offset < buffer.length; ) {
    assert.ok(offset + 8 <= buffer.length, "truncated ICNS chunk header");
    const type = buffer.subarray(offset, offset + 4).toString("ascii");
    const length = buffer.readUInt32BE(offset + 4);
    assert.ok(length >= 8 && offset + length <= buffer.length, `invalid ICNS ${type} chunk`);
    chunks.push({
      type,
      length,
      hash: sha256(buffer.subarray(offset + 8, offset + length)),
    });
    offset += length;
  }
  return chunks.sort((left, right) => left.type.localeCompare(right.type));
}

function paeth(left, above, upperLeft) {
  const prediction = left + above - upperLeft;
  const leftDistance = Math.abs(prediction - left);
  const aboveDistance = Math.abs(prediction - above);
  const upperLeftDistance = Math.abs(prediction - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
  return aboveDistance <= upperLeftDistance ? above : upperLeft;
}

function decodeRgbaPng(buffer) {
  assert.ok(buffer.subarray(0, 8).equals(PNG_SIGNATURE), "invalid PNG signature");
  let width;
  let height;
  const compressed = [];
  for (let offset = 8; offset < buffer.length; ) {
    assert.ok(offset + 12 <= buffer.length, "truncated PNG chunk");
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    assert.ok(dataEnd + 4 <= buffer.length, `truncated PNG ${type} chunk`);
    if (type === "IHDR") {
      width = buffer.readUInt32BE(dataStart);
      height = buffer.readUInt32BE(dataStart + 4);
      assert.equal(buffer[dataStart + 8], 8, "icon PNG must use 8-bit channels");
      assert.equal(buffer[dataStart + 9], 6, "icon PNG must use RGBA color");
      assert.equal(buffer[dataStart + 12], 0, "icon PNG must not be interlaced");
    } else if (type === "IDAT") {
      compressed.push(buffer.subarray(dataStart, dataEnd));
    }
    offset = dataEnd + 4;
  }
  assert.ok(width > 0 && height > 0 && compressed.length > 0, "PNG is incomplete");
  const bytesPerPixel = 4;
  const stride = width * bytesPerPixel;
  const encoded = inflateSync(Buffer.concat(compressed));
  assert.equal(encoded.length, (stride + 1) * height, "unexpected PNG payload length");
  const pixels = Buffer.alloc(stride * height);
  for (let row = 0; row < height; row += 1) {
    const filter = encoded[row * (stride + 1)];
    const sourceOffset = row * (stride + 1) + 1;
    const targetOffset = row * stride;
    for (let column = 0; column < stride; column += 1) {
      const raw = encoded[sourceOffset + column];
      const left = column >= bytesPerPixel ? pixels[targetOffset + column - bytesPerPixel] : 0;
      const above = row > 0 ? pixels[targetOffset + column - stride] : 0;
      const upperLeft =
        row > 0 && column >= bytesPerPixel
          ? pixels[targetOffset + column - stride - bytesPerPixel]
          : 0;
      let value;
      switch (filter) {
        case 0:
          value = raw;
          break;
        case 1:
          value = raw + left;
          break;
        case 2:
          value = raw + above;
          break;
        case 3:
          value = raw + Math.floor((left + above) / 2);
          break;
        case 4:
          value = raw + paeth(left, above, upperLeft);
          break;
        default:
          assert.fail(`unsupported PNG filter ${filter}`);
      }
      pixels[targetOffset + column] = value & 0xff;
    }
  }
  return { width, height, pixels };
}

function pngFromIco(buffer, wantedSize) {
  assert.equal(buffer.readUInt16LE(0), 0, "invalid ICO reserved field");
  assert.equal(buffer.readUInt16LE(2), 1, "invalid ICO type");
  const count = buffer.readUInt16LE(4);
  for (let index = 0; index < count; index += 1) {
    const offset = 6 + index * 16;
    const width = buffer[offset] || 256;
    const height = buffer[offset + 1] || 256;
    if (width !== wantedSize || height !== wantedSize) continue;
    const length = buffer.readUInt32LE(offset + 8);
    const imageOffset = buffer.readUInt32LE(offset + 12);
    const image = buffer.subarray(imageOffset, imageOffset + length);
    assert.ok(image.subarray(0, 8).equals(PNG_SIGNATURE), `${wantedSize}px ICO entry is not PNG`);
    return image;
  }
  assert.fail(`ICO has no ${wantedSize}px entry`);
}

function verifySmallIcon(image, expectedSize) {
  const { width, height, pixels } = decodeRgbaPng(image);
  assert.equal(width, expectedSize);
  assert.equal(height, expectedSize);
  let lightMarkPixels = 0;
  let coralPixels = 0;
  let opaqueCenterPixels = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const [red, green, blue, alpha] = pixels.subarray(offset, offset + 4);
      const inCenter =
        x >= Math.floor(width * 0.3) &&
        x < Math.ceil(width * 0.7) &&
        y >= Math.floor(height * 0.3) &&
        y < Math.ceil(height * 0.72);
      if (inCenter && red > 175 && green > 155 && blue > 145 && alpha > 160) {
        lightMarkPixels += 1;
      }
      if (
        red > 150 &&
        green > 35 &&
        green < 190 &&
        blue < 180 &&
        red > green * 1.2 &&
        red > blue * 1.2 &&
        alpha > 180
      ) {
        coralPixels += 1;
      }
      if (inCenter && alpha > 220) opaqueCenterPixels += 1;
    }
  }
  assert.ok(
    lightMarkPixels >= Math.max(3, Math.floor(expectedSize / 4)),
    `pi mark is not legible (${lightMarkPixels} pixels at ${expectedSize}px)`,
  );
  const minimumCoralPixels = expectedSize <= 16 ? 1 : expectedSize;
  assert.ok(
    coralPixels >= minimumCoralPixels,
    `coral orbit is not legible (${coralPixels} pixels)`,
  );
  assert.ok(opaqueCenterPixels >= expectedSize, "icon center is unexpectedly transparent");
}

async function main() {
  const source = await readFile(sourcePath, "utf8");
  assert.ok(source.length < 16 * 1024, "icon SVG is unexpectedly large");
  assert.match(source, /width="1024" height="1024" viewBox="0 0 1024 1024"/);
  assert.ok(source.includes(`d="${PI_PATH}"`), "icon SVG no longer contains the reviewed pi path");
  assert.doesNotMatch(source, /<(?:script|text|image|use)\b|\b(?:href|xlink:href)=|url\(https?:/i);

  const temporary = await mkdtemp(path.join(tmpdir(), "pihub-icons-"));
  try {
    const require = createRequire(import.meta.url);
    const cli = path.join(path.dirname(require.resolve("@tauri-apps/cli")), "tauri.js");
    const generated = spawnSync(
      process.execPath,
      [cli, "icon", "--output", temporary, sourcePath],
      { cwd: projectRoot, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
    );
    assert.equal(
      generated.status,
      0,
      `Tauri icon generation failed:\n${generated.stderr || generated.stdout}`,
    );

    const committedFiles = (await filesBelow(iconDirectory)).filter(
      (file) => !["app-icon.svg", "icon.icns"].includes(file),
    );
    const generatedFiles = (await filesBelow(temporary)).filter((file) => file !== "icon.icns");
    assert.deepEqual(committedFiles, generatedFiles, "generated icon file set is stale");
    for (const relative of committedFiles) {
      const [committed, fresh] = await Promise.all([
        readFile(path.join(iconDirectory, relative)),
        readFile(path.join(temporary, relative)),
      ]);
      assert.ok(committed.equals(fresh), `${relative} is stale; regenerate icons from app-icon.svg`);
    }

    const [committedIcns, generatedIcns] = await Promise.all([
      readFile(path.join(iconDirectory, "icon.icns")),
      readFile(path.join(temporary, "icon.icns")),
    ]);
    assert.deepEqual(parseIcns(committedIcns), parseIcns(generatedIcns), "macOS ICNS is stale");

    verifySmallIcon(await readFile(path.join(iconDirectory, "32x32.png")), 32);
    const ico = await readFile(path.join(iconDirectory, "icon.ico"));
    verifySmallIcon(pngFromIco(ico, 16), 16);
    console.log(`Icon assets verified: ${committedFiles.length + 2} files, pi mark clear at 16/32px`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

await main();
