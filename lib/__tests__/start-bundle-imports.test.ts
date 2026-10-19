import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

// Performance regression budget (2026-10-19): what the browser loads and runs
// before it can show a message (a notification's link, the app starting).
// Measured from the production build's source maps, Next's crypto-browserify
// polyfill (with stream, buffer and util: about 420 KB) and jszip with pako
// (about 90 KB) were in that start bundle, for a WKD SHA-1 and for opening
// theme or plugin ZIPs. This scan follows the static imports of the client
// modules the mail page starts with (dynamic import() is a separate, lazy
// chunk) and fails when one of them reaches such a package again.

const ROOT = path.resolve(__dirname, '../..');
const ENTRIES = [
  'app/(main)/layout.tsx',
  'app/(main)/[locale]/layout.tsx',
  'app/(main)/[locale]/page.tsx',
  'app/(main)/[locale]/mail/[[...segments]]/page.tsx',
];
/** Packages that must stay out of the start bundle (load them with import() where they are needed). */
const NOT_AT_START = ['crypto', 'node:crypto', 'jszip', 'pako', 'stream', 'buffer'];

const EXT = ['', '.ts', '.tsx', '.js', '.mjs', '/index.ts', '/index.tsx', '/index.js'];
function resolve(spec: string, from: string): string | null {
  let base: string | null = null;
  if (spec.startsWith('@/')) base = path.join(ROOT, spec.slice(2));
  else if (spec.startsWith('.')) base = path.resolve(path.dirname(from), spec);
  if (!base) return null;
  for (const ext of EXT) {
    const p = base + ext;
    if (existsSync(p) && statSync(p).isFile()) return p;
  }
  return null;
}

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s+(type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g;
function staticImports(file: string): { spec: string }[] {
  const src = readFileSync(file, 'utf8');
  const out: { spec: string }[] = [];
  for (const m of src.matchAll(IMPORT_RE)) {
    if (m[1]) continue; // import type / export type
    // `import { type A, type B } from` is erased too.
    const braces = /^\s*(?:import|export)\s*\{([^}]*)\}\s*from/.exec(m[0]);
    if (braces && braces[1].split(',').map((n) => n.trim()).filter(Boolean).every((n) => n.startsWith('type '))) continue;
    out.push({ spec: m[2] });
  }
  return out;
}
const isClient = (file: string) => /^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*['"]use client['"]/.test(readFileSync(file, 'utf8'));

function startBundlePackages(): Map<string, string> {
  const packages = new Map<string, string>(); // package -> a client module importing it
  const seenServer = new Set<string>();
  const seenClient = new Set<string>();
  const walkClient = (file: string) => {
    if (seenClient.has(file)) return;
    seenClient.add(file);
    for (const { spec } of staticImports(file)) {
      const target = resolve(spec, file);
      if (target) walkClient(target);
      else if (!spec.startsWith('.') && !spec.startsWith('@/')) {
        const pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
        if (!packages.has(pkg)) packages.set(pkg, path.relative(ROOT, file));
      }
    }
  };
  const walkServer = (file: string) => {
    if (seenServer.has(file)) return;
    seenServer.add(file);
    if (isClient(file)) { walkClient(file); return; }
    for (const { spec } of staticImports(file)) {
      const target = resolve(spec, file);
      if (target) walkServer(target);
    }
  };
  for (const entry of ENTRIES) walkServer(path.join(ROOT, entry));
  return packages;
}

describe('start bundle of the mail page', () => {
  it('reaches the mail app through client modules', () => {
    const packages = startBundlePackages();
    expect(packages.has('react')).toBe(true);
    expect(packages.has('dompurify')).toBe(true);
  });

  it.each(NOT_AT_START)('does not import %s statically', (pkg) => {
    const packages = startBundlePackages();
    expect(packages.get(pkg) ?? null, `${pkg} imported statically by a start module`).toBeNull();
  });
});
