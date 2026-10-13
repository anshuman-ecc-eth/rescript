#!/usr/bin/env node
/**
 * Export an edit with the *native* ffmpeg instead of ffmpeg.wasm.
 *
 * The browser export runs ffmpeg.wasm under a ~2 GiB ceiling and overruns it on
 * long / high-res renders. Native ffmpeg has no such limit, so this reads the
 * exact keep ranges the editor already computed and re-runs the same
 * trim + concat filtergraph on the desktop.
 *
 * The keep ranges come from the editor's Timeline export, which is pure text
 * and never touches ffmpeg:
 *   Export → Timeline → Reaper (.rpp)      (SOFFS = source in, LENGTH = duration)
 *   Export → Timeline → Samplitude (.edl)  (Record-In / Record-Out, in samples)
 * A plain JSON file also works: `[[start,end], ...]` or `{ "keepRanges": [...] }`.
 *
 * Usage:
 *   node scripts/export-offline.mjs \
 *     --input /path/to/6.mp4 \
 *     --ranges ~/Downloads/6.edited.rpp \
 *     [--out 6.edited.mp4] [--format mp4|webm] \
 *     [--resolution original|720|1080|2160] [--crf 22] [--dry-run]
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

function fail(message) {
  console.error(`\n[export-offline] ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    if (key === "dry-run") {
      args.dryRun = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      fail(`Option --${key} needs a value.`);
    }
    args[key] = value;
    i++;
  }
  return args;
}

/** Reaper `.rpp`: pair each item's LENGTH (written before SOFFS) with SOFFS. */
function parseRpp(text) {
  const ranges = [];
  for (const block of text.split(/<ITEM\b/).slice(1)) {
    const length = block.match(/^\s*LENGTH\s+(-?[\d.eE+-]+)\s*$/m);
    const soffs = block.match(/^\s*SOFFS\s+(-?[\d.eE+-]+)\s*$/m);
    if (!length || !soffs) continue;
    const start = Number(soffs[1]);
    const end = start + Number(length[1]);
    if (Number.isFinite(start) && end > start) ranges.push({ start, end });
  }
  return ranges;
}

/** Samplitude EDL: `Source Track Play-In Play-Out Record-In Record-Out …` (samples). */
function parseEdl(text) {
  const rateMatch = text.match(/^Sample Rate:\s*(\d+)/m);
  const rate = rateMatch ? Number(rateMatch[1]) : 48000;
  const ranges = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().startsWith("#") || line.trim().startsWith("Track")) continue;
    const m = line.match(
      /^\s*\d+\s+\d+\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+[\d.]+/
    );
    if (!m) continue;
    const sourceIn = Number(m[3]) / rate;
    const sourceOut = Number(m[4]) / rate;
    if (sourceOut > sourceIn) ranges.push({ start: sourceIn, end: sourceOut });
  }
  return ranges;
}

function parseJson(text) {
  const data = JSON.parse(text);
  const list = Array.isArray(data) ? data : data.keepRanges;
  if (!Array.isArray(list)) fail("JSON must be [[start,end],…] or { keepRanges: […] }.");
  return list.map((r) =>
    Array.isArray(r)
      ? { start: Number(r[0]), end: Number(r[1]) }
      : { start: Number(r.start), end: Number(r.end) }
  );
}

function parseRanges(path) {
  const text = readFileSync(path, "utf8");
  let ranges;
  if (/<REAPER_PROJECT/.test(text)) ranges = parseRpp(text);
  else if (/Samplitude EDL/.test(text)) ranges = parseEdl(text);
  else ranges = parseJson(text);
  ranges = ranges.filter(
    (r) => Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start
  );
  if (ranges.length === 0) fail(`No keep ranges found in ${path}.`);
  return ranges;
}

function probeStreams(input) {
  try {
    const out = execFileSync(
      "ffprobe",
      [
        "-v", "error",
        "-show_entries", "stream=codec_type",
        "-of", "default=noprint_wrappers=1:nokey=1",
        input,
      ],
      { encoding: "utf8" }
    );
    return {
      hasVideo: /(^|\n)video(\n|$)/.test(out),
      hasAudio: /(^|\n)audio(\n|$)/.test(out),
    };
  } catch {
    fail("Could not probe the input with ffprobe. Is ffmpeg on your PATH?");
  }
}

const HEIGHTS = { 720: 720, 1080: 1080, 2160: 2160 };

function scaleFilter(resolution) {
  if (resolution === "original") return null;
  const h = HEIGHTS[resolution];
  if (!h) fail(`Unknown --resolution "${resolution}" (original|720|1080|2160).`);
  return `scale=-2:'min(ih,${h})',scale=trunc(iw/2)*2:trunc(ih/2)*2`;
}

function buildFilter(ranges, withVideo, withAudio, resolution) {
  const parts = [];
  const labels = [];
  ranges.forEach((r, i) => {
    const s = r.start.toFixed(3);
    const e = r.end.toFixed(3);
    let label = "";
    if (withVideo) {
      parts.push(`[0:v]trim=start=${s}:end=${e},setpts=PTS-STARTPTS[v${i}]`);
      label += `[v${i}]`;
    }
    if (withAudio) {
      parts.push(`[0:a]atrim=start=${s}:end=${e},asetpts=PTS-STARTPTS[a${i}]`);
      label += `[a${i}]`;
    }
    labels.push(label);
  });
  const scale = withVideo ? scaleFilter(resolution) : null;
  let filter =
    parts.join(";") +
    `;${labels.join("")}concat=n=${ranges.length}:v=${withVideo ? 1 : 0}:a=${
      withAudio ? 1 : 0
    }[outv]${withVideo && withAudio ? "[outa]" : ""}`;
  if (!withVideo) {
    // No video stream: the concat output label is audio-only.
    filter = filter.replace("[outv]", "[outa]");
    return { filter, videoMap: null };
  }
  if (scale) filter += `;[outv]${scale}[vout]`;
  return { filter, videoMap: scale ? "[vout]" : "[outv]" };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input) fail("Missing --input <media file>.");
  if (!args.ranges) fail("Missing --ranges <rpp|edl|json> (Export → Timeline).");
  const input = resolve(args.input);
  if (!existsSync(input)) fail(`Input not found: ${input}`);
  const rangesPath = resolve(args.ranges);
  if (!existsSync(rangesPath)) fail(`Ranges file not found: ${rangesPath}`);

  const format = args.format ?? "mp4";
  if (format !== "mp4" && format !== "webm") fail('--format must be "mp4" or "webm".');
  const resolution = args.resolution ?? "original";
  const crf = args.crf ?? (format === "webm" ? "35" : "22");

  const ranges = parseRanges(rangesPath);
  const { hasVideo, hasAudio } = probeStreams(input);
  if (!hasVideo && !hasAudio) fail("Input has no audio or video streams.");

  const ext = format === "webm" ? "webm" : "mp4";
  const out = resolve(
    args.out ?? join(dirname(input), `${basename(input).replace(/\.[^.]+$/, "")}.edited.${ext}`)
  );

  const { filter, videoMap } = buildFilter(ranges, hasVideo, hasAudio, resolution);

  const codecArgs =
    format === "webm"
      ? [
          "-c:v", "libvpx-vp9", "-crf", String(crf), "-b:v", "0",
          "-row-mt", "1", "-cpu-used", "8",
          ...(hasAudio ? ["-c:a", "libopus", "-b:a", "128k"] : []),
        ]
      : [
          "-c:v", "libx264", "-preset", "ultrafast", "-crf", String(crf),
          ...(hasAudio ? ["-c:a", "aac", "-b:a", "192k"] : []),
          "-movflags", "+faststart",
        ];

  const ffArgs = ["-i", input, "-filter_complex", filter];
  if (hasVideo) ffArgs.push("-map", videoMap);
  if (hasAudio) ffArgs.push("-map", hasVideo ? "[outa]" : "[outa]");
  else ffArgs.push("-an");
  ffArgs.push(...codecArgs, "-y", out);

  const total = ranges.reduce((n, r) => n + (r.end - r.start), 0);
  console.log(
    `[export-offline] ${ranges.length} keep range(s), ${total.toFixed(1)}s edited ` +
      `→ ${out}`
  );
  console.log(`[export-offline] ffmpeg ${ffArgs.join(" ")}`);

  if (args.dryRun) return;

  const result = spawnSync("ffmpeg", ffArgs, { stdio: "inherit" });
  if (result.status !== 0) fail(`ffmpeg exited with code ${result.status}.`);
  console.log(`[export-offline] done: ${out}`);
}

main();
