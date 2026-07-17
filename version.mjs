// Version check: queries GitHub releases API for latest version tag.
// Caches result for 24h. Prints upgrade notice to stderr if newer exists.
// Skip with OCASK_NO_VERSION_CHECK=1.

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const REPO = 'anthonykewl20/ocask';
const CURRENT_VERSION = '0.1.0';
const RELEASES_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const CACHE_DIR = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'ocask');
const CACHE_FILE = path.join(CACHE_DIR, 'version-check.json');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export { CURRENT_VERSION };

async function ensureCacheDir() {
  await fs.mkdir(CACHE_DIR, { recursive: true, mode: 0o700 });
}

async function readCache() {
  try {
    const raw = await fs.readFile(CACHE_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (Date.now() - data.checked_at > CACHE_TTL_MS) return null;
    return data;
  } catch { return null; }
}

async function writeCache(latest, current) {
  await ensureCacheDir();
  await fs.writeFile(CACHE_FILE, JSON.stringify({
    checked_at: Date.now(),
    latest,
    current,
  }), { mode: 0o600 });
}

function newerThan(a, b) {
  // Semantic version comparison (loose: handles v prefix, missing patch)
  const clean = (v) => v.replace(/^v/, '').split('.').map(Number);
  const aa = clean(a), bb = clean(b);
  for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
    if ((aa[i] || 0) > (bb[i] || 0)) return true;
    if ((aa[i] || 0) < (bb[i] || 0)) return false;
  }
  return false;
}

export async function checkVersion(options = {}) {
  if (process.env.OCASK_NO_VERSION_CHECK === '1') return { current: CURRENT_VERSION, latest: null, upgrade: false };

  const cached = await readCache();
  if (cached && !options.force) {
    return { current: CURRENT_VERSION, latest: cached.latest, upgrade: newerThan(cached.latest, CURRENT_VERSION) };
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(RELEASES_URL, {
      headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'ocask-version-check' },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      // GitHub API may rate-limit. Cache "unknown" so we don't retry immediately.
      await writeCache(CURRENT_VERSION, CURRENT_VERSION);
      return { current: CURRENT_VERSION, latest: null, upgrade: false };
    }

    const release = await res.json();
    const latest = release.tag_name || CURRENT_VERSION;
    await writeCache(latest, CURRENT_VERSION);
    return { current: CURRENT_VERSION, latest, upgrade: newerThan(latest, CURRENT_VERSION) };
  } catch {
    await writeCache(CURRENT_VERSION, CURRENT_VERSION);
    return { current: CURRENT_VERSION, latest: null, upgrade: false };
  }
}

// Called at startup to print upgrade notice to stderr (non-blocking, fail-safe).
export async function notifyUpgrade() {
  if (process.env.OCASK_NO_VERSION_CHECK === '1') return;
  try {
    const { latest, upgrade } = await checkVersion();
    if (upgrade && latest) {
      console.error(`\nocask ${CURRENT_VERSION} → ${latest} available. Run: ocask upgrade\n`);
    }
  } catch { /* fail-open: never block on version check */ }
}
