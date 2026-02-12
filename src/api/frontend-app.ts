import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function tryRead(paths: string[]): string | null {
  for (const path of paths) {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      continue;
    }
  }
  return null;
}

function moduleDir() {
  return dirname(fileURLToPath(import.meta.url));
}

function legacyCandidates() {
  const dir = moduleDir();
  return [
    join(dir, 'static', 'app.html'),
    join(dir, '../../../src/api/static/app.html'),
    join(process.cwd(), 'src/api/static/app.html'),
  ];
}

function unifiedCandidates(assetPath: string) {
  const dir = moduleDir();
  return [
    join(dir, 'static', 'unified', assetPath),
    join(dir, '../../../src/api/static/unified', assetPath),
    join(process.cwd(), 'src/api/static/unified', assetPath),
    join(process.cwd(), 'apps/orchestrator-ui/dist', assetPath),
  ];
}

export function readLegacyFrontendHtml(): string {
  return (
    tryRead(legacyCandidates()) || '<!doctype html><html><body><h1>Legacy frontend asset missing</h1></body></html>'
  );
}

export function readUnifiedFrontendAsset(assetPath: string): string | null {
  return tryRead(unifiedCandidates(assetPath));
}

export const FRONTEND_APP_HTML = readLegacyFrontendHtml();
