import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { asRunId, type Producer } from '../../record/index.js';
import { addFinding } from '../../finding.js';

// The gatekeeper CLI surface. An agent (v1 skill) or a script produces a raw
// finding and pipes it here; addFinding validates the schema, caps confidence
// by rule metadata, computes the frozen fingerprint, and stamps the producer.
// No producer can inflate its own authority — that check lives in record, not
// in a prompt.

function readRaw(values: { file?: string; json?: string }): unknown {
  if (values.file) return JSON.parse(fs.readFileSync(values.file, 'utf8'));
  if (values.json) return JSON.parse(values.json);
  const stdin = fs.readFileSync(0, 'utf8').trim();
  if (!stdin) throw new Error('no finding given: pass --file, --json, or pipe JSON on stdin');
  return JSON.parse(stdin);
}

function buildProducer(values: Record<string, string | boolean | undefined>): Producer {
  const s = (k: string): string | undefined => (typeof values[k] === 'string' ? (values[k] as string) : undefined);
  const type = s('producer') ?? 'agent';
  switch (type) {
    case 'agent':
      return { type: 'agent', model: s('model') ?? 'unknown', rubricVersion: s('rubric-version') ?? 'unknown' };
    case 'rule':
      return { type: 'rule', packageVersion: s('package-version') ?? '0.0.0' };
    case 'engine':
      return { type: 'engine', name: s('name') ?? 'unknown', version: s('engine-version') ?? '0.0.0' };
    default:
      throw new Error(`unknown --producer: ${type} (agent | rule | engine)`);
  }
}

export function cmdFindingAdd(argv: string[]): number {
  const { values } = parseArgs({
    args: argv,
    options: {
      run: { type: 'string' },
      file: { type: 'string' },
      json: { type: 'string' },
      producer: { type: 'string' },
      model: { type: 'string' },
      'rubric-version': { type: 'string' },
      'package-version': { type: 'string' },
      name: { type: 'string' },
      'engine-version': { type: 'string' },
      cwd: { type: 'string' },
      dry: { type: 'boolean' },
    },
    allowPositionals: false,
  });

  if (!values.run) {
    process.stderr.write('finding add needs --run <runId>\n');
    return 2;
  }

  const raw = readRaw(values);
  const finding = addFinding(raw, {
    runId: asRunId(values.run),
    producer: buildProducer(values),
    cwd: values.cwd,
    persist: !values.dry,
  });

  process.stdout.write(
    `${values.dry ? '[dry] ' : ''}${finding.fingerprint} ` +
      `[${finding.severity}/${finding.confidence}] ${String(finding.requirementId)}\n`,
  );
  return 0;
}
