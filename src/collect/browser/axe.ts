import { createRequire } from 'node:module';
import fs from 'node:fs';
import type { Page } from 'playwright';
import type { Artifact, Subject } from '../../record/index.js';

// Family A: the axe-core rules-engine pass, injected into the live DOM. In the
// rendered page this supersedes the static layer's template checks —
// accessible-name computation runs for real, ARIA refs resolve, label
// associations work across component boundaries. axe results map through the
// registry engine table; axe's `incomplete` becomes needs-review (a feature).
//
// axe-core is a regular dep (injected, not a peer). Its version is pinned to
// match the registry mapping table; test/axe-drift.test.ts guards the pairing.

const require = createRequire(import.meta.url);

let axeSourceCache: string | undefined;
function axeSource(): string {
  if (axeSourceCache === undefined) {
    axeSourceCache = fs.readFileSync(require.resolve('axe-core'), 'utf8');
  }
  return axeSourceCache;
}

interface AxeNode {
  // A flat array of selectors for a plain element; an OPEN shadow root nests
  // one hop as a string[] entry (see axeTargetToPath below).
  target?: (string | string[])[];
  html?: string;
  failureSummary?: string;
  // Source localization added post-run (not axe's own): the owning Vue SFC via
  // the dev-build instance chain, and the style-scope id as a fallback.
  sourceFile?: string | null;
  scopeId?: string | null;
  // Document-absolute bounding box, captured post-run — the geometry key the
  // pipeline uses to match this node against OTHER collectors' measurements of
  // the same element (e.g. the pixel-band contrast pass).
  box?: { x: number; y: number; width: number; height: number } | null;
  // The element's visible text (trimmed, bounded) — so a text-level finding can
  // QUOTE what reads badly, not just point at it.
  text?: string | null;
  // axe's per-check results (carry computed fg/bg colours for contrast checks).
  any?: unknown[];
  all?: unknown[];
  // CSS variables that resolve, on this element, to axe's computed colours —
  // so a colour fix targets `--text-muted`, not a literal.
  fgVars?: string[] | null;
  bgVars?: string[] | null;
}
interface AxeRuleResult {
  id: string;
  impact?: string | null;
  help?: string;
  nodes: AxeNode[];
}
interface AxeRun {
  violations: AxeRuleResult[];
  incomplete: AxeRuleResult[];
  testEngine?: { name: string; version: string };
}

export async function runAxe(page: Page, subject: Subject, capturedAt: string): Promise<Artifact> {
  await page.addScriptTag({ content: axeSource() });
  const result = (await page.evaluate(async () => {
    // @ts-expect-error axe is injected into the page global at runtime.
    const r = await axe.run(document, {
      resultTypes: ['violations', 'incomplete'],
      // Element refs come back as CSS-path targets; enough to anchor evidence.
      elementRef: false,
    });
    return {
      violations: r.violations,
      incomplete: r.incomplete,
      testEngine: r.testEngine,
    };
  })) as AxeRun;

  // Second in-page pass: resolve each node's target selector back to its element
  // and ask the framework runtime which source file owns it. Vue dev builds
  // expose el.__vueParentComponent → …type.__file; the data-v scope id is the
  // fallback the pipeline can map when __file is stripped. Best-effort: any
  // selector that no longer matches (DOM moved on) just stays unlocalized.
  // Contrast checks carry the computed colours axe judged — hand them to the
  // in-page pass so it can name the CSS variables they came from.
  const nodeColors = (n: AxeNode): { fg: string | null; bg: string | null } => {
    for (const chk of [...(n.any ?? []), ...(n.all ?? [])]) {
      const d = (chk as { data?: { fgColor?: unknown; bgColor?: unknown } }).data;
      if (d && typeof d.fgColor === 'string' && typeof d.bgColor === 'string') return { fg: d.fgColor, bg: d.bgColor };
    }
    return { fg: null, bg: null };
  };
  // axe's `target` for a plain element is a flat array of selector strings
  // (join with a space: a single node addressed across, say, a media-query
  // boundary). For an element inside an OPEN shadow root it instead NESTS one
  // hop: `[["my-card", "p"]]` means `document.querySelector("my-card")
  // .shadowRoot.querySelector("p")` — the nested array element IS the path,
  // one entry per shadow hop. The old code did `n.target.join(' ')`
  // regardless of shape: `Array.prototype.join` stringifies a nested array
  // element with ITS OWN default separator (comma), so a shadow target became
  // a selector LIST like `"my-card,p"` — which `document.querySelector`
  // resolves to the FIRST element in the WHOLE DOCUMENT matching EITHER
  // branch, silently quoting some unrelated element's text and box instead of
  // the shadow element at all (test/axe-shadow-target.test.ts reproduces this
  // against real axe-core output). Convert to the hop-path shape up front and
  // walk it explicitly in the page.
  function axeTargetToPath(target: (string | string[])[] | undefined): string[] | null {
    if (!target || target.length === 0) return null;
    const nested = target.find((t): t is string[] => Array.isArray(t));
    if (nested) return nested;
    return target as string[];
  }
  const targets: Array<{ i: number; j: number; path: string[]; fg: string | null; bg: string | null }> = [];
  const all = [...result.violations.map((r, i) => ({ r, list: 'v' as const, i })), ...result.incomplete.map((r, i) => ({ r, list: 'i' as const, i }))];
  for (const { r, list, i } of all) {
    r.nodes.forEach((n, j) => {
      const path = axeTargetToPath(n.target);
      if (path) targets.push({ i: list === 'v' ? i : i + result.violations.length, j, path, ...nodeColors(n) });
    });
  }
  if (targets.length) {
    try {
      const resolved = (await page.evaluate((ts: Array<{ i: number; j: number; path: string[]; fg: string | null; bg: string | null }>) => {
        function cssVarNames(): string[] {
          const w = window as unknown as { __ckVarNames?: string[] };
          if (w.__ckVarNames) return w.__ckVarNames;
          const names = new Set<string>();
          const walk = (rules: CSSRuleList): void => {
            for (const r of Array.from(rules)) {
              const st = (r as CSSStyleRule).style;
              if (st) for (let i = 0; i < st.length; i++) if (st[i].startsWith('--')) names.add(st[i]);
              const sub = (r as CSSMediaRule).cssRules;
              if (sub) walk(sub);
            }
          };
          for (const sheet of Array.from(document.styleSheets)) {
            try {
              if (sheet.cssRules) walk(sheet.cssRules);
            } catch {
              /* cross-origin */
            }
          }
          w.__ckVarNames = Array.from(names).slice(0, 600);
          return w.__ckVarNames;
        }
        const memo = new Map<string, string>();
        let probe: HTMLElement | null = null;
        function normColor(v: string): string {
          const hit = memo.get(v);
          if (hit !== undefined) return hit;
          if (!probe) {
            probe = document.createElement('div');
            probe.style.display = 'none';
            document.body.appendChild(probe);
          }
          probe.style.color = '';
          probe.style.color = v;
          const out = probe.style.color ? getComputedStyle(probe).color : '';
          memo.set(v, out);
          return out;
        }
        function matchVars(el: Element, fg: string | null, bg: string | null): { fgVars: string[]; bgVars: string[] } {
          const fgVars: string[] = [];
          const bgVars: string[] = [];
          const fgN = fg ? normColor(fg) : '';
          const bgN = bg ? normColor(bg) : '';
          if (!fgN && !bgN) return { fgVars, bgVars };
          const cs = getComputedStyle(el);
          for (const name of cssVarNames()) {
            const raw = cs.getPropertyValue(name).trim();
            if (!raw) continue;
            const norm = normColor(raw);
            if (!norm) continue;
            if (fgN && norm === fgN && fgVars.length < 4) fgVars.push(name);
            if (bgN && norm === bgN && bgVars.length < 4) bgVars.push(name);
          }
          return { fgVars, bgVars };
        }
        function vueFile(el: Element): string | null {
          let node: Element | null = el;
          while (node) {
            const inst = (node as unknown as { __vueParentComponent?: { type?: { __file?: string }; parent?: unknown } })
              .__vueParentComponent;
            if (inst) {
              let c: { type?: { __file?: string }; parent?: unknown } | undefined = inst;
              while (c) {
                const f = c.type?.__file;
                if (typeof f === 'string' && f) return f;
                c = c.parent as typeof c;
              }
              return null;
            }
            node = node.parentElement;
          }
          return null;
        }
        function vueScopeId(el: Element): string | null {
          let node: Element | null = el;
          while (node) {
            for (const a of node.getAttributeNames()) {
              const m = a.match(/^data-v-([0-9a-f]{7,8})$/);
              if (m) return m[1];
            }
            node = node.parentElement;
          }
          return null;
        }
        // Walk the shadow path hop by hop: `document.querySelector(path[0])`,
        // then `.shadowRoot.querySelector(path[1])`, … A step that fails to
        // find an element, or a hop into a CLOSED shadow root (no
        // `.shadowRoot`), means the path cannot be honestly resolved — return
        // null rather than fall back to a plain-DOM lookup that could match
        // some unrelated element and quote its text/box instead.
        function resolveTarget(path: string[]): Element | null {
          let root: Document | ShadowRoot = document;
          let el: Element | null = null;
          for (let i = 0; i < path.length; i++) {
            el = root.querySelector(path[i]);
            if (!el) return null;
            if (i < path.length - 1) {
              if (!el.shadowRoot) return null;
              root = el.shadowRoot;
            }
          }
          return el;
        }
        return ts.map((t) => {
          try {
            const el = resolveTarget(t.path);
            if (!el) return { ...t, file: null, scope: null, box: null, text: null, fgVars: [], bgVars: [] };
            const r = el.getBoundingClientRect();
            // Document-absolute (viewport rect + scroll), matching how the
            // contrast collector records candidate boxes.
            const ck = (window as unknown as { __ck?: { contentBox(e: Element): { x: number; y: number; width: number; height: number } } }).__ck;
            const box = ck ? ck.contentBox(el) : { x: r.x + window.scrollX, y: r.y + window.scrollY, width: r.width, height: r.height };
            const raw = (el.textContent ?? '').trim().replace(/\s+/g, ' ');
            const text = raw ? (raw.length > 80 ? raw.slice(0, 80) + '…' : raw) : null;
            const vars = matchVars(el, t.fg, t.bg);
            return { ...t, file: vueFile(el), scope: vueScopeId(el), box, text, fgVars: vars.fgVars, bgVars: vars.bgVars };
          } catch {
            return { ...t, file: null, scope: null, box: null, text: null, fgVars: [], bgVars: [] };
          }
        });
      }, targets)) as Array<{ i: number; j: number; file: string | null; scope: string | null; box: { x: number; y: number; width: number; height: number } | null; text: string | null; fgVars: string[]; bgVars: string[] }>;
      const rules = [...result.violations, ...result.incomplete];
      for (const r of resolved) {
        const node = rules[r.i]?.nodes[r.j];
        if (node) {
          node.sourceFile = r.file;
          node.scopeId = r.scope;
          node.box = r.box;
          node.text = r.text;
          node.fgVars = r.fgVars.length ? r.fgVars : null;
          node.bgVars = r.bgVars.length ? r.bgVars : null;
        }
      }
    } catch {
      /* localization is best-effort — axe results stand on their own */
    }
  }

  return {
    kind: 'axe-result',
    subject,
    capturedAt,
    results: result as unknown as Record<string, unknown>,
  };
}
