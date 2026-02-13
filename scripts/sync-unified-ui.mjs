#!/usr/bin/env node
import { cpSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repoRoot = resolve(new URL('..', import.meta.url).pathname);
const sourceDir = join(repoRoot, 'apps/orchestrator-ui/src');

const targets = [
  { dir: join(repoRoot, 'apps/orchestrator-ui/dist'), preserve: [] },
  { dir: join(repoRoot, 'src/api/static/unified'), preserve: [] },
  {
    dir: join(repoRoot, 'apps/vercel-console'),
    preserve: ['.vercel', 'vercel.json', '.gitignore'],
  },
];

function listFiles(dir, prefix = '') {
  const entries = readdirSync(dir);
  const files = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const rel = prefix ? `${prefix}/${entry}` : entry;
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      files.push(...listFiles(fullPath, rel));
      continue;
    }
    files.push(rel);
  }
  return files;
}

const files = listFiles(sourceDir);

function shouldPreserve(path, preserve) {
  return preserve.some((entry) => path === entry || path.startsWith(`${entry}/`));
}

let removedCount = 0;
let copiedCount = 0;

for (const target of targets) {
  mkdirSync(target.dir, { recursive: true });
  const existingFiles = listFiles(target.dir);
  for (const existing of existingFiles) {
    if (files.includes(existing) || shouldPreserve(existing, target.preserve)) {
      continue;
    }
    rmSync(join(target.dir, existing), { force: true });
    removedCount += 1;
  }

  for (const file of files) {
    const from = join(sourceDir, file);
    const to = join(target.dir, file);
    mkdirSync(join(to, '..'), { recursive: true });
    cpSync(from, to);
    copiedCount += 1;
  }
}

console.log(
  `Synced ${files.length} UI assets to ${targets.length} targets (copied ${copiedCount}, removed ${removedCount}).`,
);
