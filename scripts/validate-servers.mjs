#!/usr/bin/env node
/**
 * Publish gate for api/servers.json.
 *
 * build-servers.mjs already throws when a source fails to parse at all. The
 * failure this guards against is subtler and worse: a source that still parses
 * but yields far less than it should — asra reshuffles its wiki table, a
 * selector half-matches, and we quietly publish 40 servers instead of 1100.
 * Nothing downstream would notice; the app would just look emptier.
 *
 * So: structural checks, absolute floors, and a regression check against the
 * previously committed copy. Exits non-zero to fail the workflow before the
 * commit step runs.
 */

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_FILE = path.join(ROOT, 'api', 'servers.json');

// Absolute floors. asra alone supplies ~1100; anything under 500 total means
// the big source broke even if it did not throw.
const MIN_TOTAL = 500;
const MIN_OPEN_REGISTRATION = 400;
// Largest acceptable one-run shrink versus the last published file. Servers do
// come and go, but not by a third overnight.
const MAX_SHRINK_RATIO = 0.33;
const MAX_AGE_HOURS = 48;
// How long a source may serve nothing but cache before it stops being a blip.
// Only enforced under --freshness-gate (see below); as a publish gate it would
// do the opposite of its job, freezing the whole API over one dead upstream.
const MAX_STALE_DAYS = 3;

// Two modes, one script:
//   (default)          publish gate — runs BEFORE the commit, must not fail on
//                      a stale source, because publishing cached data beats
//                      publishing nothing.
//   --freshness-gate   health gate  — runs AFTER the push, and turns the run
//                      red when a source has been stale for days. privacydev
//                      spent 21 days stale across 21 green runs; that is the
//                      hole this closes.
const FRESHNESS_GATE = process.argv.includes('--freshness-gate');

const errors = [];
const warnings = [];

const fail = (msg) => errors.push(msg);
const warn = (msg) => warnings.push(msg);

const raw = readFileSync(OUT_FILE, 'utf8');
const data = JSON.parse(raw);

// ---- structure --------------------------------------------------------------

if (data.version !== 1) fail(`unexpected schema version: ${data.version}`);
if (!Array.isArray(data.servers)) fail('servers is not an array');
if (!Array.isArray(data.sources)) fail('sources is not an array');

const ageHours = (Date.now() - new Date(data.generated_at).getTime()) / 3_600_000;
if (!Number.isFinite(ageHours)) fail(`generated_at is unparseable: ${data.generated_at}`);
else if (ageHours > MAX_AGE_HOURS) fail(`generated_at is ${ageHours.toFixed(1)}h old`);
else if (ageHours < -1) fail(`generated_at is in the future: ${data.generated_at}`);

// ---- counts -----------------------------------------------------------------

const total = data.servers?.length ?? 0;
if (total !== data.counts?.total) fail(`counts.total ${data.counts?.total} != servers.length ${total}`);
if (total < MIN_TOTAL) fail(`only ${total} servers — floor is ${MIN_TOTAL}`);

const open = data.servers?.filter((s) => s?.registration?.open).length ?? 0;
if (open < MIN_OPEN_REGISTRATION) {
  fail(`only ${open} open-registration servers — floor is ${MIN_OPEN_REGISTRATION}`);
}

// ---- per-source health ------------------------------------------------------

const byId = Object.fromEntries((data.sources ?? []).map((s) => [s.id, s]));
for (const id of ['asra', 'joinmatrix', 'privacydev']) {
  const s = byId[id];
  if (!s) {
    fail(`source ${id} missing from output`);
    continue;
  }
  // A stale source is tolerable — that is what the cache is for — but it must
  // be visible in the logs rather than passing silently, and it must stop
  // being tolerable once it has gone on for days.
  if (s.stale) {
    const age = s.cache_age_days;
    const msg =
      `source ${id} is STALE (${Number.isFinite(age) ? `${age}d` : 'no cache'}, ` +
      `${s.error ?? 'no error given'}), serving cache`;
    if (FRESHNESS_GATE && Number.isFinite(age) && age >= MAX_STALE_DAYS) {
      fail(`${msg} — past the ${MAX_STALE_DAYS}d freshness limit`);
    } else {
      warn(msg);
    }
  }
  if (s.count === 0) warn(`source ${id} contributed 0 entries`);
}
if ((data.sources ?? []).every((s) => s.stale)) fail('every source is stale — nothing fresh at all');

// ---- per-server sanity ------------------------------------------------------

const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const seen = new Map();
let badName = 0;
let badSources = 0;

for (const s of data.servers ?? []) {
  if (!s || typeof s !== 'object') {
    badName += 1;
    continue;
  }
  if (typeof s.name !== 'string' || !HOSTNAME_RE.test(s.name)) {
    if (badName < 5) fail(`invalid server name: ${JSON.stringify(s.name)}`);
    badName += 1;
  }
  if (!Array.isArray(s.sources) || s.sources.length === 0) {
    badSources += 1;
  }
  if (seen.has(s.name)) {
    fail(`duplicate server name survived dedupe: ${s.name}`);
  } else {
    seen.set(s.name, true);
  }
}
if (badName > 5) fail(`${badName} servers have invalid names`);
if (badSources) fail(`${badSources} servers carry no source attribution`);

// ---- regression against the last published copy -----------------------------

let previous = null;
try {
  previous = JSON.parse(execFileSync('git', ['show', 'HEAD:api/servers.json'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  }));
} catch {
  warn('no previously committed api/servers.json to compare against (first run?)');
}

if (previous?.counts?.total) {
  const before = previous.counts.total;
  const shrink = (before - total) / before;
  if (shrink > MAX_SHRINK_RATIO) {
    fail(
      `server count fell ${(shrink * 100).toFixed(1)}% (${before} → ${total}), ` +
        `over the ${(MAX_SHRINK_RATIO * 100).toFixed(0)}% limit — refusing to publish`,
    );
  } else if (total !== before) {
    const delta = total - before;
    console.log(`[validate] count ${before} → ${total} (${delta >= 0 ? '+' : ''}${delta})`);
  }
}

// ---- report -----------------------------------------------------------------

for (const w of warnings) console.warn(`[validate] WARN ${w}`);

if (errors.length) {
  for (const e of errors) console.error(`[validate] FAIL ${e}`);
  console.error(
    `[validate] ${errors.length} error(s) — ` +
      `${FRESHNESS_GATE ? 'data was published, but this run is unhealthy' : 'not publishing'}`,
  );
  process.exit(1);
}

console.log(
  `[validate] OK${FRESHNESS_GATE ? ' (freshness gate)' : ''} — ${total} servers, ` +
  `${open} with open registration, ` +
    `${data.counts.merged_from_multiple_sources} merged from >1 source`,
);
