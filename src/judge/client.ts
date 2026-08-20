import type { Adjudicator } from './adjudicate.js';
import type { VerdictValue } from '../record/index.js';

// The real mode-1 adjudicator — the ONLY place the Anthropic SDK is imported
// (dependency law). One small image + one rubric + a forced-tool output schema,
// so the verdict is structured at the API level (no free-form parsing). Server
// auth is an API key (ANTHROPIC_API_KEY); interactive OAuth is not for
// non-interactive workloads (constraints carried from the plan).

export interface AnthropicAdjudicatorOptions {
  apiKey?: string; // defaults to ANTHROPIC_API_KEY
  model?: string;
}

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

export async function createAnthropicAdjudicator(opts: AnthropicAdjudicatorOptions = {}): Promise<{ adjudicator: Adjudicator; model: string }> {
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('no ANTHROPIC_API_KEY — set it to run `complykit review`, or the needs-review queue stays a manual slice.');
  }
  let Anthropic: typeof import('@anthropic-ai/sdk').default;
  try {
    Anthropic = (await import('@anthropic-ai/sdk')).default;
  } catch {
    throw new Error("the review layer needs the '@anthropic-ai/sdk' peer. Install it with `npm i -D @anthropic-ai/sdk`.");
  }
  const client = new Anthropic({ apiKey });
  const model = opts.model ?? DEFAULT_MODEL;

  const adjudicator: Adjudicator = async ({ crop, rubric, requirementId }) => {
    const message = await client.messages.create({
      model,
      max_tokens: 512,
      tool_choice: { type: 'tool', name: 'record_verdict' },
      tools: [
        {
          name: 'record_verdict',
          description: 'Record the verdict for the crop under the given requirement.',
          input_schema: {
            type: 'object',
            properties: {
              verdict: { type: 'string', enum: ['violation', 'pass', 'unclear'] },
              reason: { type: 'string' },
            },
            required: ['verdict', 'reason'],
          },
        },
      ],
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: crop.toString('base64') } },
            { type: 'text', text: `${rubric}\n\nRequirement under test: ${requirementId}. Call record_verdict with your judgment.` },
          ],
        },
      ],
    });
    const toolUse = message.content.find((c): c is { type: 'tool_use'; input: unknown } & typeof c => c.type === 'tool_use');
    const input = (toolUse?.input ?? {}) as { verdict?: string; reason?: string };
    const verdict: VerdictValue = input.verdict === 'violation' || input.verdict === 'pass' ? input.verdict : 'unclear';
    return { verdict, reason: input.reason ?? 'no reason given' };
  };

  return { adjudicator, model };
}
