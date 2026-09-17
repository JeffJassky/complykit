#!/usr/bin/env node
// Ground-truth accuracy oracle for WCAG 1.4.3 contrast measurement — see
// plans/glyph-contrast-plan.md section 5. Serves the fixture over a local
// static server, runs a real scan + JSON report against it, then scores every
// case in test/fixtures/pages/contrast-truth.html against what the scanner
// actually reported. This is a report, not a gate: it always exits 0.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const fixtureDir = path.join(repoRoot, 'test', 'fixtures', 'pages');
const fixtureFile = path.join(fixtureDir, 'contrast-truth.html');

const { values } = parseArgs({
  options: {
    cli: { type: 'string' },
    out: { type: 'string' },
  },
});
const cliPath = values.cli ? path.resolve(values.cli) : path.join(repoRoot, 'dist', 'cli.js');

// ---------------------------------------------------------------------------
// 1. Ground truth: parse data-case/data-expect/data-ratio off the fixture.

function parseCases(html) {
  const cases = [];
  const re = /data-case="([^"]+)"/g;
  let m;
  while ((m = re.exec(html))) {
    const id = m[1];
    // Scan backward/forward from the data-case attribute for the sibling
    // data-expect/data-ratio attributes on the SAME tag (the tag may open
    // up to ~400 chars before this attribute and close up to ~200 after).
    const tagStart = html.lastIndexOf('<', m.index);
    const tagEnd = html.indexOf('>', m.index);
    const tag = html.slice(tagStart, tagEnd + 1);
    const expectM = /data-expect="([^"]+)"/.exec(tag);
    const ratioM = /data-ratio="([^"]+)"/.exec(tag);
    cases.push({
      id,
      expect: expectM ? expectM[1] : null,
      ratio: ratioM ? Number(ratioM[1]) : null,
    });
  }
  return cases;
}

const fixtureHtml = fs.readFileSync(fixtureFile, 'utf8');
const cases = parseCases(fixtureHtml);

// ---------------------------------------------------------------------------
// 2. Serve the fixture dir over a free port.

const MIME = { '.html': 'text/html', '.png': 'image/png' };

function serveDir(dir) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
      const filePath = path.join(dir, urlPath === '/' ? 'contrast-truth.html' : urlPath);
      if (!filePath.startsWith(dir)) {
        res.writeHead(403);
        res.end();
        return;
      }
      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] ?? 'application/octet-stream' });
        res.end(data);
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function run(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function main() {
  const server = await serveDir(fixtureDir);
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/contrast-truth.html`;

  const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'complykit-contrast-truth-'));
  const reportOut = path.join(tmpCwd, 'r.json');

  const wallStart = Date.now();
  let scanResult;
  let reportResult;
  try {
    scanResult = await run(
      process.execPath,
      [cliPath, 'scan', '--url', url, '--max-pages', '1'],
      { cwd: tmpCwd },
    );
    if (scanResult.code !== 0) {
      process.stderr.write(`scan exited ${scanResult.code}\n${scanResult.stdout}\n${scanResult.stderr}\n`);
    }
    reportResult = await run(
      process.execPath,
      [cliPath, 'report', '--format', 'json', '--out', reportOut, '--cwd', tmpCwd],
      { cwd: tmpCwd },
    );
    if (reportResult.code !== 0) {
      process.stderr.write(`report exited ${reportResult.code}\n${reportResult.stdout}\n${reportResult.stderr}\n`);
    }
  } finally {
    server.close();
  }
  const wallMs = Date.now() - wallStart;

  if (!fs.existsSync(reportOut)) {
    process.stderr.write(`no JSON report produced at ${reportOut} — scan/report output above.\n`);
    process.exit(0);
  }

  const report = JSON.parse(fs.readFileSync(reportOut, 'utf8'));
  const defects = (report.defects ?? []).filter((d) => d.requirementId === 'wcag22.1.4.3');

  // -------------------------------------------------------------------------
  // 3. Attribution: element -> computed-style "text" -> message, in order;
  // within the first field that contains any "Cnn " token, the earliest
  // token wins.

  const TOKEN_RE = /C\d{2}(?=\s)/g;

  function firstToken(field) {
    if (!field) return null;
    let best = null;
    let bestIdx = Infinity;
    TOKEN_RE.lastIndex = 0;
    let m;
    while ((m = TOKEN_RE.exec(field))) {
      if (m.index < bestIdx) {
        bestIdx = m.index;
        best = m[0];
      }
    }
    return best;
  }

  function attribute(defect) {
    // A selector that names the case's own container is the strongest signal:
    // axe's target for a case paragraph is `section[data-case="C08"] > p`.
    const own = /data-case="(C\d{2})"/.exec(defect.element ?? '');
    if (own) return own[1];
    // Form controls carry the case in their id (`#c23-input`): their text is a
    // value or placeholder, which no selector or text field quotes.
    const byId = /#c(\d{2})-/i.exec(defect.element ?? '');
    if (byId) return `C${byId[1]}`;
    const fields = [defect.element, defect.computedStyle?.text, defect.message];
    for (const f of fields) {
      const tok = firstToken(f);
      if (tok) return tok;
    }
    return null;
  }

  function parseRatio(defect) {
    const style = defect.computedStyle ?? {};
    const ratioProp = style.ratio ?? style.Ratio;
    if (typeof ratioProp === 'string') {
      const m = /(\d+(?:\.\d+)?)(\s*:\s*1)?/.exec(ratioProp);
      if (m) return Number(m[1]);
    }
    const msg = defect.message ?? '';
    // axe's summary: "insufficient color contrast of 3.94 (foreground …".
    const axe = /contrast of (\d+(?:\.\d+)?)/.exec(msg);
    if (axe) return Number(axe[1]);
    const m = /(\d+(?:\.\d+)?)\s*:\s*1/.exec(msg);
    if (m) return Number(m[1]);
    return null;
  }

  const byCase = new Map(); // caseId -> { violation?: defect, needsReview?: defect }
  for (const d of defects) {
    const tok = attribute(d);
    if (!tok) {
      // A contrast finding the corpus cannot place is still a finding; list it
      // so it is never silently discounted.
      console.log(`unattributed ${d.confidence}: ${d.element} — ${String(d.message).slice(0, 90)}`);
      continue;
    }
    if (process.env.SCORE_DEBUG) console.log(`${tok} <= ${d.confidence} ${d.element}`);
    if (!byCase.has(tok)) byCase.set(tok, {});
    const bucket = byCase.get(tok);
    if (d.confidence === 'violation' && !bucket.violation) bucket.violation = d;
    else if (d.confidence === 'needs-review' && !bucket.needsReview) bucket.needsReview = d;
  }

  // -------------------------------------------------------------------------
  // 4. Score.

  const rows = [];
  const totals = { TP: 0, TN: 0, FP: 0, FN: 0, unresolved: 0, ratioErrors: 0, limitations: 0 };

  for (const c of cases) {
    const bucket = byCase.get(c.id) ?? {};
    const got = bucket.violation ? 'violation' : bucket.needsReview ? 'needs-review' : 'none';
    const gotDefect = bucket.violation ?? bucket.needsReview ?? null;
    const gotRatio = gotDefect ? parseRatio(gotDefect) : null;

    let verdict;
    if (c.expect === 'limitation') {
      verdict = 'skipped';
      totals.limitations++;
    } else if (c.expect === 'pass') {
      verdict = got === 'violation' ? 'FP' : got === 'needs-review' ? 'unresolved' : 'TN';
    } else if (c.expect === 'fail') {
      verdict = got === 'violation' ? 'TP' : got === 'needs-review' ? 'unresolved' : 'FN';
    } else if (c.expect === 'none') {
      verdict = got === 'violation' || got === 'needs-review' ? 'FP' : 'TN';
    } else if (c.expect === 'gap-ok') {
      verdict = got === 'violation' ? 'FP' : 'TN';
    } else {
      verdict = 'unknown-expect';
    }
    if (verdict in totals) totals[verdict]++;

    let ratioError = false;
    if (c.ratio != null && gotRatio != null && Math.abs(gotRatio - c.ratio) > 0.05) {
      ratioError = true;
      totals.ratioErrors++;
    }

    rows.push({
      id: c.id,
      expect: c.expect,
      expectRatio: c.ratio,
      got,
      gotRatio,
      verdict,
      ratioError,
    });
  }

  // -------------------------------------------------------------------------
  // 5. Print + optionally write markdown.

  const header = ['id', 'expect', 'exp.ratio', 'got', 'got.ratio', 'verdict', 'ratio-err'];
  const lines = [];
  lines.push(`# Contrast ground-truth scoring`);
  lines.push('');
  lines.push(`CLI: \`${path.relative(repoRoot, cliPath)}\``);
  lines.push(`Scan exit: ${scanResult.code}, report exit: ${reportResult.code}, wall time: ${wallMs}ms`);
  lines.push('');
  lines.push(`| ${header.join(' | ')} |`);
  lines.push(`| ${header.map(() => '---').join(' | ')} |`);
  for (const r of rows) {
    lines.push(
      `| ${r.id} | ${r.expect} | ${r.expectRatio ?? ''} | ${r.got} | ${r.gotRatio ?? ''} | ${r.verdict} | ${r.ratioError ? 'yes' : ''} |`,
    );
  }
  lines.push('');
  lines.push(
    `**Totals** — TP: ${totals.TP}, TN: ${totals.TN}, FP: ${totals.FP}, FN: ${totals.FN}, ` +
      `unresolved: ${totals.unresolved}, ratio errors: ${totals.ratioErrors}, limitation (unscored): ${totals.limitations}, ` +
      `wall time: ${wallMs}ms`,
  );
  const md = lines.join('\n') + '\n';

  process.stdout.write(md);

  if (values.out) {
    fs.writeFileSync(values.out, md);
    process.stdout.write(`\nwrote ${values.out}\n`);
  }

  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`${err.stack ?? err}\n`);
  process.exit(0);
});
