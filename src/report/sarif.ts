import type { Finding, Run, Severity } from '../record/index.js';

// SARIF 2.1.0 output — for GitHub code-scanning annotations and any SARIF-aware
// CI. One SARIF run per complykit run; each finding is a result keyed by its
// frozen fingerprint (partialFingerprints), so code-scanning dedupes across
// runs the same way complykit's own diff does.

const SARIF_SCHEMA = 'https://json.schemastore.org/sarif-2.1.0.json';

// SARIF has three levels; complykit has four severities. Map by audit weight.
function sarifLevel(severity: Severity): 'error' | 'warning' | 'note' {
  switch (severity) {
    case 'critical':
    case 'serious':
      return 'error';
    case 'moderate':
      return 'warning';
    case 'minor':
      return 'note';
  }
}

function locationFor(finding: Finding): Record<string, unknown> | undefined {
  // Prefer a file:line from the subject or a file-evidence item.
  const fileEv = finding.evidence.find((e) => e.kind === 'file');
  const file = finding.subject.file;
  const uri = file?.path ?? (fileEv && fileEv.kind === 'file' ? fileEv.path : undefined);
  if (!uri) return undefined;
  const line = file?.line ?? (fileEv && fileEv.kind === 'file' ? fileEv.line : undefined);
  return {
    physicalLocation: {
      artifactLocation: { uri },
      ...(line ? { region: { startLine: line } } : {}),
    },
  };
}

export function renderSarif(run: Run, findings: Finding[]): string {
  // De-duplicate rule descriptors by ruleId.
  const ruleIds = [...new Set(findings.map((f) => String(f.ruleId)))];
  const rules = ruleIds.map((id) => ({
    id,
    properties: { requirements: [...new Set(findings.filter((f) => String(f.ruleId) === id).map((f) => String(f.requirementId)))] },
  }));

  const results = findings.map((f) => {
    const loc = locationFor(f);
    return {
      ruleId: String(f.ruleId),
      level: sarifLevel(f.severity),
      message: { text: f.message },
      ...(loc ? { locations: [loc] } : {}),
      partialFingerprints: { complykitFingerprintV1: String(f.fingerprint) },
      properties: {
        requirement: String(f.requirementId),
        confidence: f.confidence,
        severity: f.severity,
        producer: f.producer.type,
      },
    };
  });

  const doc = {
    $schema: SARIF_SCHEMA,
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'complykit',
            informationUri: 'https://jeffjassky.github.io/complykit/',
            version: run.versions.package,
            rules,
          },
        },
        results,
      },
    ],
  };
  return JSON.stringify(doc, null, 2);
}
