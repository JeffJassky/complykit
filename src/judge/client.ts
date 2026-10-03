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

// --- Knowledge-base research (plans/consent-design.md §4.2) ------------------
//
// One domain per call: the model searches the web (server-side web_search),
// reads vendor docs, and answers through a forced-shape tool (propose_entry) so
// the proposal is structured at the API level. Returns the raw tool input —
// the store validates it (sources required) and records it as a PROPOSAL; a
// person confirms. Sonnet by default: this is reading and judgment, not a crop.

export interface ResearchRequest {
  system: string;
  brief: string;
  /** JSON schema for propose_entry's input. */
  schema: Record<string, unknown>;
}
export type Researcher = (req: ResearchRequest) => Promise<{ body: unknown; model: string; searches: number }>;

export interface AnthropicResearcherOptions {
  apiKey?: string; // defaults to ANTHROPIC_API_KEY
  model?: string; // defaults to COMPLYKIT_RESEARCH_MODEL, then Sonnet
  maxSearches?: number;
}

const DEFAULT_RESEARCH_MODEL = 'claude-sonnet-5-5';

export async function createAnthropicResearcher(opts: AnthropicResearcherOptions = {}): Promise<{ researcher: Researcher; model: string }> {
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('no ANTHROPIC_API_KEY — set it to research with the API, or use `complykit kb packet <domain>` and import the result with `kb propose`.');
  }
  let Anthropic: typeof import('@anthropic-ai/sdk').default;
  try {
    Anthropic = (await import('@anthropic-ai/sdk')).default;
  } catch {
    throw new Error("research needs the '@anthropic-ai/sdk' peer. Install it with `npm i -D @anthropic-ai/sdk`.");
  }
  const client = new Anthropic({ apiKey });
  const model = opts.model ?? process.env.COMPLYKIT_RESEARCH_MODEL ?? DEFAULT_RESEARCH_MODEL;

  const researcher: Researcher = async ({ system, brief, schema }) => {
    const tools = [
      { type: 'web_search_20250305', name: 'web_search', max_uses: opts.maxSearches ?? 8 },
      { name: 'propose_entry', description: 'Record the proposed knowledge-base entry for this domain.', input_schema: schema },
    ];
    type Msg = { role: 'user' | 'assistant'; content: unknown };
    const messages: Msg[] = [{ role: 'user', content: brief }];
    let searches = 0;
    let nudged = false;
    // Server tools may pause a long turn (pause_turn): resend to continue.
    for (let turn = 0; turn < 8; turn++) {
      const message = await client.messages.create({
        model,
        max_tokens: 8000,
        system,
        // The SDK's tool union lags new server-tool versions; the API accepts them.
        tools: tools as never,
        messages: messages as never,
      });
      for (const c of message.content) if (c.type === 'server_tool_use') searches++;
      const call = message.content.find((c) => c.type === 'tool_use' && c.name === 'propose_entry');
      if (call && call.type === 'tool_use') return { body: call.input, model, searches };
      messages.push({ role: 'assistant', content: message.content });
      if (message.stop_reason === 'pause_turn') continue;
      if (nudged) break;
      nudged = true;
      messages.push({ role: 'user', content: 'Call propose_entry now with what you have established (use confidence "low" if unsure).' });
    }
    throw new Error('the model did not return a proposal');
  };
  return { researcher, model };
}
