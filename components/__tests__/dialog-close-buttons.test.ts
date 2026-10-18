import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// An icon-only close button (an <X /> and nothing else) has no accessible
// name unless it carries one: VoiceOver read the email source dialog's close
// button as just "button" (iOS Simulator, 2026-10-18). Every icon-only X
// button that closes or cancels something must carry an aria-label (or title).
// Buttons that remove a chip or clear a field are out of scope here.
const ROOT = path.resolve(__dirname, "../..");
const CLOSES = /onClick=\{\s*(?:onClose|onCancel|\(\)\s*=>\s*(?:on[A-Z]\w*Close|set\w+\(\s*false\s*\)|on(?:Close|Cancel)\(\)))\s*\}/;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (name === "__tests__" || name === "node_modules") return [];
    if (statSync(full).isDirectory()) return sources(full);
    return full.endsWith(".tsx") ? [full] : [];
  });
}

/** End of a JSX open tag that starts at `from` (brace-aware, `=>` safe). */
function openTagEnd(src: string, from: number): number {
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth === 0 && src[i - 1] !== "=") return i;
  }
  return -1;
}

function unnamedCloseButtons(src: string, where: string): string[] {
  const found: string[] = [];
  const open = /<(button|Button)\b/g;
  for (let m = open.exec(src); m; m = open.exec(src)) {
    const end = openTagEnd(src, m.index + 1);
    if (end < 0) continue;
    const tag = src.slice(m.index, end);
    const close = src.indexOf(`</${m[1]}>`, end);
    if (close < 0) continue;
    const body = src.slice(end + 1, close).trim();
    if (!/^<X\b[^>]*\/>$/.test(body)) continue; // icon-only X buttons
    if (!CLOSES.test(tag)) continue;
    if (/aria-label=|aria-labelledby=|title=/.test(tag)) continue;
    found.push(`${where}:${src.slice(0, m.index).split("\n").length}`);
  }
  return found;
}

describe("dialog close buttons", () => {
  it("every icon-only X button that closes something has an accessible name", () => {
    const files = [...sources(path.join(ROOT, "components")), ...sources(path.join(ROOT, "app"))];
    expect(files.length).toBeGreaterThan(100);
    expect(files.flatMap((f) => unnamedCloseButtons(readFileSync(f, "utf8"), path.relative(ROOT, f)))).toEqual([]);
  });

  it("finds an unnamed one and accepts a named one (the check is not vacuous)", () => {
    const unnamed = 'const A = () => (\n  <button onClick={onClose} className="p-1">\n    <X className="w-4 h-4" />\n  </button>\n);\n';
    const named = unnamed.replace('className="p-1"', 'className="p-1" aria-label={t("close")}');
    const remove = unnamed.replace("onClick={onClose}", "onClick={() => removeChip(id)}");
    expect(unnamedCloseButtons(unnamed, "a.tsx")).toEqual(["a.tsx:2"]);
    expect(unnamedCloseButtons(named, "a.tsx")).toEqual([]);
    expect(unnamedCloseButtons(remove, "a.tsx")).toEqual([]);
  });
});
