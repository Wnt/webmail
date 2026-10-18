import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// An icon-only close button (an <X /> and nothing else) has no accessible
// name unless it carries one: VoiceOver read the email source dialog's close
// button as just "button" (iOS Simulator, 2026-10-18). Every icon-only X
// button that closes or cancels something must carry an aria-label (or title).
// The general check below covers every other icon-only control.
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

const files = ["components", "app", "contexts", "hooks", "lib"].flatMap((dir) => sources(path.join(ROOT, dir)));

describe("dialog close buttons", () => {
  it("every icon-only X button that closes something has an accessible name", () => {
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

// Every control whose content is only icons needs a name of its own, not just
// the ones that close something. VoiceOver read the X that removes a recipient
// chip, a search chip or a contact field, and the X on a toast, as just
// "button"; the selection check boxes in the contact list said nothing either.
// A control is icon-only when its children are icons from @/components/icons
// (or an `Icon`/`...Icon` component), possibly behind `cond && …` or
// `cond ? … : …`, and nothing else. It is named by aria-label,
// aria-labelledby, title or an sr-only text, and not when that name is only
// there some of the time (`title={busy ? t("cancel") : undefined}`).
const ICONS = new Set(
  [...readFileSync(path.join(ROOT, "components/icons/index.ts"), "utf8").matchAll(/\bas (\w+)\b/g)].map((m) => m[1]),
);
const isIcon = (name: string) => ICONS.has(name) || name === "Icon" || /Icon$/.test(name);
// A self-closing component tag, attributes may hold one level of nested braces.
const SELF_CLOSING = /<([A-Z]\w*)\b(?:[^<>{}]|\{(?:[^{}]|\{[^{}]*\})*\})*\/>/g;
const NAMED = /\baria-label=|\baria-labelledby=|\btitle=/;
const SOMETIMES_NAMED = /\b(?:aria-label|title)=\{[^{}]*:\s*undefined\s*\}/g;

function iconOnly(body: string): boolean {
  let rest = body.replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
  let icons = 0;
  rest = rest.replace(SELF_CLOSING, (tag, name: string) => (isIcon(name) ? (icons++, "ICON") : tag));
  if (icons === 0) return false;
  rest = rest
    .replace(/\(\s*ICON\s*\)/g, "ICON")
    .replace(/\{[^{}]*\}/g, (block) =>
      /^\{\s*ICON\s*\}$/.test(block)
      || /^\{[^{}<]*\?\s*(?:ICON|null)\s*:\s*(?:ICON|null)\s*\}$/.test(block)
      || /^\{[^{}<]*&&\s*ICON\s*\}$/.test(block)
        ? "ICON"
        : "TEXT",
    );
  return rest.replace(/ICON/g, "").trim() === "";
}

/** Close tag of the element opened at `from`, counting nested ones of the same name. */
function closeTagAt(src: string, name: string, from: number): number {
  const re = new RegExp(`<${name}\\b|</${name}>`, "g");
  re.lastIndex = from;
  let depth = 1;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    if (m[0].startsWith("</")) {
      if (--depth === 0) return m.index;
    } else {
      const end = openTagEnd(src, m.index + 1);
      if (end > 0 && src[end - 1] !== "/") depth++;
    }
  }
  return -1;
}

function unnamedIconControls(src: string, where: string): string[] {
  const found: string[] = [];
  const open = /<(button|Button|a|Link|span|div)\b/g;
  for (let m = open.exec(src); m; m = open.exec(src)) {
    const end = openTagEnd(src, m.index + 1);
    if (end < 0) continue;
    const name = m[1];
    const tag = src.slice(m.index, end);
    const control = name === "button" || name === "Button" || name === "a" || name === "Link" || /\brole="button"/.test(tag);
    if (!control) continue;
    if (NAMED.test(tag.replace(SOMETIMES_NAMED, ""))) continue;
    if (/\{\s*\.\.\./.test(tag)) continue; // spread props can carry the name (ui/button.tsx)
    let unnamed: boolean;
    if (src[end - 1] === "/") {
      // <button … /> draws nothing to read; a self-closing <Link /> is the icon.
      unnamed = name === "button" || name === "Button";
    } else {
      const close = closeTagAt(src, name, end + 1);
      if (close < 0) continue;
      const body = src.slice(end + 1, close);
      unnamed = iconOnly(body) && !/\bsr-only\b/.test(body);
    }
    if (unnamed) found.push(`${where}:${src.slice(0, m.index).split("\n").length}`);
  }
  return found;
}

describe("icon-only controls", () => {
  it("every button, link or role=button whose content is only icons has an accessible name", () => {
    expect(files.flatMap((f) => unnamedIconControls(readFileSync(f, "utf8"), path.relative(ROOT, f)))).toEqual([]);
  });

  it("finds unnamed ones and accepts named ones (the check is not vacuous)", () => {
    const chip = '<span>\n  {kw}\n  <button type="button" onClick={() => remove(kw)}>\n    <X className="w-3 h-3" />\n  </button>\n</span>\n';
    expect(unnamedIconControls(chip, "a.tsx")).toEqual(["a.tsx:3"]);
    expect(unnamedIconControls(chip.replace("onClick=", 'aria-label={t("remove_item", { name: kw })} onClick='), "a.tsx")).toEqual([]);
    expect(unnamedIconControls(chip.replace("onClick=", 'title={t("remove")} onClick='), "a.tsx")).toEqual([]);

    // Icons behind a condition, in a library Button.
    const toggle = '<Button onClick={toggle}>\n  {open ? <ChevronDown className={cn("w-4", a && "b")} /> : <ChevronRight />}\n</Button>\n';
    expect(unnamedIconControls(toggle, "b.tsx")).toEqual(["b.tsx:1"]);
    const checkbox = '<button onClick={pick}>\n  {checked ? (\n    <CheckSquare className="w-4 h-4" />\n  ) : (\n    <Square className="w-4 h-4" />\n  )}\n</button>\n';
    expect(unnamedIconControls(checkbox, "c.tsx")).toEqual(["c.tsx:1"]);

    // A name that is only there while uploading is no name the rest of the time.
    const sometimes = '<button onClick={remove} title={busy ? t("cancel") : undefined}>\n  <X />\n</button>\n';
    expect(unnamedIconControls(sometimes, "d.tsx")).toEqual(["d.tsx:1"]);

    // role="button" on a span, and an empty self-closing button.
    expect(unnamedIconControls('<span role="button" tabIndex={0} onClick={go}><Plus className="w-3" /></span>', "e.tsx")).toEqual(["e.tsx:1"]);
    expect(unnamedIconControls('<button type="button" onClick={() => pick(1, 2)} className="w-4 h-4" />', "f.tsx")).toEqual(["f.tsx:1"]);

    // Text, a label variable, an sr-only text or a non-icon child is a name.
    expect(unnamedIconControls('<button onClick={go}><Plus className="w-3" />{t("add")}</button>', "g.tsx")).toEqual([]);
    expect(unnamedIconControls('<button onClick={go}><Plus className="w-3" /> Add</button>', "g.tsx")).toEqual([]);
    expect(unnamedIconControls('<button onClick={go}><Plus /><span className="sr-only">{t("add")}</span></button>', "g.tsx")).toEqual([]);
    expect(unnamedIconControls('<button onClick={go}><Avatar name={n} /></button>', "g.tsx")).toEqual([]);
    // The Link icon is not a link.
    expect(unnamedIconControls('<Link className="w-3 h-3 text-muted-foreground flex-shrink-0" />', "h.tsx")).toEqual([]);
  });
});
