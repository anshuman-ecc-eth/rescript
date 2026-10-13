/**
 * Regression: video export must use the growable single-threaded ffmpeg core.
 *
 * `@ffmpeg/core-mt` hard-declares a fixed 1 GiB shared WebAssembly.Memory.
 * High-res exports (1080p / original) and Electron sessions that still hold
 * ASR heaps either fail to instantiate that buffer ("ffmpeg not starting") or
 * OOM mid-encode. `@ffmpeg/core` grows 32 MiB → 2 GiB and is what export
 * selects; copy-assets must ship both binaries.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  coreAssetBase,
  exportCoreKind,
  keepRangesExpr,
  type FFmpegCoreKind,
} from "../lib/ffmpeg";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function main() {
  assert(exportCoreKind() === "st", "export uses the single-threaded core");
  assert(
    coreAssetBase("st") === "/vendor/ffmpeg-st",
    "ST assets are served from /vendor/ffmpeg-st"
  );
  assert(
    coreAssetBase("mt") === "/vendor/ffmpeg",
    "MT assets stay at /vendor/ffmpeg"
  );

  const root = join(import.meta.dirname, "..");
  const required: Record<FFmpegCoreKind, string[]> = {
    mt: ["ffmpeg-core.js", "ffmpeg-core.wasm", "ffmpeg-core.worker.js"],
    st: ["ffmpeg-core.js", "ffmpeg-core.wasm"],
  };
  for (const kind of Object.keys(required) as FFmpegCoreKind[]) {
    const dir = join(root, "public", ...coreAssetBase(kind).split("/").filter(Boolean));
    for (const file of required[kind]) {
      assert(
        existsSync(join(dir, file)),
        `missing ${kind} asset ${file} under ${dir} (run postinstall / copy-assets)`
      );
    }
    if (kind === "st") {
      assert(
        !existsSync(join(dir, "ffmpeg-core.worker.js")),
        "single-threaded core must not ship a pthread worker"
      );
    }
  }

  // Large exports are read back from MEMFS in 64 MiB chunks (lib/ffmpeg.ts
  // readOutput) instead of one full-size `readFile` copy, which is what a long
  // 1080p render overran the worker with. Both halves of the @ffmpeg/ffmpeg
  // patch have to be present and copied to public/ for that path to engage.
  const classDir = join(root, "public/vendor/ffmpeg-class");
  const workerSrc = readFileSync(join(classDir, "worker.js"), "utf8");
  assert(
    workerSrc.includes("offset === undefined") &&
      workerSrc.includes('FS.open(path, "r")'),
    "vendored worker must support chunked readFile (patches/ + copy-assets)"
  );
  const classSrc = readFileSync(join(classDir, "classes.js"), "utf8");
  assert(
    classSrc.includes("readFileChunk"),
    "vendored FFmpeg class must expose readFileChunk"
  );

  // Export keeps ranges via a single streaming `select` rather than a trim pad
  // per range + a giant `concat` (which buffered a frame per cut and OOM'd the
  // wasm heap). The expression has to stay one quoted filter argument: its
  // commas are inside between(...) and must not be read as filter separators.
  assert(
    keepRangesExpr([{ start: 1.25, end: 3.75 }]) === "between(t,1.250,3.750)",
    "keepRangesExpr formats one range"
  );
  assert(
    keepRangesExpr([
      { start: 1.25, end: 3.75 },
      { start: 10, end: 13.25 },
    ]) === "between(t,1.250,3.750)+between(t,10.000,13.250)",
    "keepRangesExpr joins ranges with +"
  );

  console.log("ALL FFMPEG CORE TESTS PASSED");
}

main();
