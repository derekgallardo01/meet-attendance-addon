#!/usr/bin/env node
// Sync the customer-facing static files into the backend's served mirror.
//
// The in-Meet add-on + marketing site load from GitHub Pages (attendancetracker.dev),
// but the Cloud Run backend also serves a copy under backend/public/ (e.g. for
// same-origin API calls). These must stay identical EXCEPT for one line: the
// backend copy of index.html points backendUrl at the same-origin "/api" instead
// of the absolute Cloud Run URL.
//
// This replaces a manual copy + `sed` that was done by hand on every frontend
// change (and whose "byte-for-byte" invariant had already drifted via CRLF/LF).
//
//   node scripts/sync-public.mjs          # write the mirror
//   node scripts/sync-public.mjs --check  # exit 1 if the mirror is stale (CI)

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'backend', 'public');

// Root-relative paths that are mirrored into backend/public/ under the same name.
const MIRRORED = [
  'admin.html',
  'attendance-tracker-for-teachers.html',
  'best-google-meet-attendance-extensions.html',
  'export-google-meet-attendance-to-sheets.html',
  'google-meet-attendance-for-churches.html',
  'google-meet-attendance-for-cpe-and-cle-credits.html',
  'google-meet-attendance-for-fitness-and-yoga.html',
  'google-meet-attendance-for-job-interviews.html',
  'google-meet-attendance-for-legal-depositions.html',
  'google-meet-attendance-for-remote-teams.html',
  'google-meet-attendance-for-tutors.html',
  'google-meet-attendance-for-universities.html',
  'google-meet-attendance-for-volunteer-hours.html',
  'google-meet-attendance-google-classroom.html',
  'google-meet-attendance-on-ipad-and-mobile.html',
  'google-meet-attendance-philippines-teachers.html',
  'google-meet-attendance-report-not-showing-up.html',
  'google-meet-clinical-supervision-and-therapy.html',
  'google-meet-quorum-and-board-meetings.html',
  'google-meet-vs-zoom-attendance-tracking.html',
  'history.html',
  'how-to-send-google-meet-attendance-to-slack.html',
  'how-to-track-attendance-in-google-meet.html',
  'index.html',
  'pricing.html',
  'privacy.html',
  'refunds.html',
  'setup.html',
  'share.html',
  'verify.html',
  'support.html',
  'team.html',
  'terms.html',
  'track-attendance-for-webinars-and-training-google-meet.html',
  'track-google-meet-attendance-without-host.html',
  'js/utils.js',
  'js/strings.js',
  'js/api.js',
  'js/share.js',
  'js/team.js',
  'js/history.js',
  'js/admin.js',
  'js/panel.js',
  'js/sim.js',
  'pwa-install.js',
  'robots.txt',
  'sitemap.xml',
];

// index.html is the only file that differs: the served copy uses same-origin /api.
function transform(relPath, contents) {
  if (relPath !== 'index.html') return contents;
  const rewritten = contents.replace(
    /backendUrl:\s*'https:\/\/[^']*\/api'/,
    "backendUrl: '/api'"
  );
  if (rewritten === contents) {
    throw new Error(
      "index.html: could not find the absolute backendUrl to rewrite to '/api'. " +
      'Did the APP_CONFIG.backendUrl line change shape?'
    );
  }
  return rewritten;
}

// Normalize to LF so the mirror is stable regardless of the source's line endings.
const toLF = (s) => s.replace(/\r\n/g, '\n');

const check = process.argv.includes('--check');
const stale = [];

for (const rel of MIRRORED) {
  const src = toLF(readFileSync(join(ROOT, rel), 'utf8'));
  const want = transform(rel, src);
  const destPath = join(PUBLIC, rel);

  if (check) {
    // Compare CONTENT, not line endings: git (core.autocrlf) may hand us a
    // CRLF working tree on Windows while storing LF, so normalize both sides.
    let have = null;
    try { have = toLF(readFileSync(destPath, 'utf8')); } catch { /* missing */ }
    if (have !== want) stale.push(rel);
  } else {
    writeFileSync(destPath, want);
  }
}

if (check) {
  if (stale.length) {
    console.error('backend/public mirror is STALE for:\n  ' + stale.join('\n  '));
    console.error('\nRun: npm run sync:public');
    process.exit(1);
  }
  console.log('backend/public mirror is in sync.');
} else {
  console.log(`Synced ${MIRRORED.length} files into backend/public/.`);
}
