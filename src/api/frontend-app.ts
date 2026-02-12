import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function readFrontendHtml(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(moduleDir, 'static', 'app.html'),
    join(moduleDir, '../../../src/api/static/app.html'),
    join(process.cwd(), 'src/api/static/app.html'),
  ];

  for (const path of candidates) {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      continue;
    }
  }

  return '<!doctype html><html><body><h1>Frontend asset missing</h1></body></html>';
}

export const FRONTEND_APP_HTML = readFrontendHtml();
