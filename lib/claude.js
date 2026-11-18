// Every call to Claude goes through here. The API key is read from the server's
// environment and never leaves the server.
import Anthropic from '@anthropic-ai/sdk';

export const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-5-5';

// List prices in US dollars per million tokens, used to report the cost of each call.
// Check https://www.anthropic.com/pricing if you change the model.
const PRICES = {
  'claude-opus-5-5': { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.1 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
};
const WEB_SEARCH_PER_SEARCH = 10 / 1000; // $10 per 1,000 searches

let client;
function anthropic() {
  if (!client) client = new Anthropic(); // reads ANTHROPIC_API_KEY
  return client;
}

export class ClaudeError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

function addUsage(total, u) {
  if (!u) return total;
  total.input_tokens += u.input_tokens || 0;
  total.output_tokens += u.output_tokens || 0;
  total.cache_creation_input_tokens += u.cache_creation_input_tokens || 0;
  total.cache_read_input_tokens += u.cache_read_input_tokens || 0;
  total.web_search_requests += u.server_tool_use?.web_search_requests || 0;
  return total;
}

export function costOf(usage, model = MODEL) {
  const p = PRICES[model];
  if (!p) return null;
  const dollars =
    (usage.input_tokens * p.input +
      usage.output_tokens * p.output +
      usage.cache_creation_input_tokens * p.cacheWrite +
      usage.cache_read_input_tokens * p.cacheRead) / 1e6 +
    usage.web_search_requests * WEB_SEARCH_PER_SEARCH;
  return Math.round(dollars * 10000) / 10000;
}

// Sends one request. Server-side tools (web search) can pause a long turn; we resume
// it a few times. Returns every content block from every round, plus summed usage.
export async function ask({ label, system, messages, tools, outputSchema, effort = 'medium', maxTokens = 16000 }) {
  const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, web_search_requests: 0 };
  const convo = [...messages];
  const blocks = [];
  let response;

  for (let round = 0; round < 4; round++) {
    const params = {
      model: MODEL,
      max_tokens: maxTokens,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: convo,
      output_config: { effort },
      // If Claude declines on a safety classifier, the API retries on a suitable model.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    };
    if (tools) params.tools = tools;
    if (outputSchema) params.output_config.format = { type: 'json_schema', schema: outputSchema };

    try {
      response = await anthropic().beta.messages.create(params);
    } catch (err) {
      throw translateError(err);
    }
    addUsage(usage, response.usage);
    blocks.push(...response.content);

    if (response.stop_reason === 'pause_turn') {
      convo.push({ role: 'assistant', content: response.content });
      continue;
    }
    break;
  }

  if (response.stop_reason === 'refusal') {
    throw new ClaudeError('Claude declined to process this request. Check the document is a CV and try again.', 422);
  }
  if (response.stop_reason === 'max_tokens') {
    throw new ClaudeError('The response was too long and got cut off. Please try again.', 502);
  }

  const cost = costOf(usage, response.model || MODEL);
  console.log(JSON.stringify({ event: 'claude_call', label, model: response.model, ...usage, cost_usd: cost }));
  return { blocks, text: lastText(response.content), usage, cost, model: response.model };
}

function lastText(content) {
  return content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
}

function translateError(err) {
  if (err instanceof Anthropic.AuthenticationError) {
    return new ClaudeError('The Anthropic API key is missing or wrong. Check ANTHROPIC_API_KEY on the server.', 500);
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return new ClaudeError(`Anthropic refused this request: ${err.message}`, 500);
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new ClaudeError('Too many requests to Claude right now. Wait a minute and try again.', 429);
  }
  if (err instanceof Anthropic.BadRequestError) {
    console.error('Anthropic bad request:', err.message);
    return new ClaudeError(`Claude could not process this request: ${err.message}`, 502);
  }
  if (err instanceof Anthropic.APIError) {
    console.error('Anthropic error:', err.status, err.message);
    return new ClaudeError('Claude is not responding properly right now. Please try again shortly.', 502);
  }
  console.error(err);
  return new ClaudeError('Could not reach Claude. Please try again.', 502);
}

// Pulls the first JSON value out of a text reply (with or without a ```json fence).
export function parseJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.search(/[[{]/);
  if (start === -1) throw new ClaudeError('Claude did not return the expected data. Please try again.');
  const open = candidate[start];
  const close = open === '[' ? ']' : '}';
  const end = candidate.lastIndexOf(close);
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    throw new ClaudeError('Claude returned data that could not be read. Please try again.');
  }
}

// Every URL that came back from a web search or web fetch in this conversation.
export function searchedUrls(blocks) {
  const urls = new Set();
  for (const b of blocks) {
    if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) {
      for (const r of b.content) if (r.url) urls.add(r.url);
    }
    if (b.type === 'web_fetch_tool_result' && b.content?.url) urls.add(b.content.url);
  }
  return urls;
}

export function searchErrors(blocks) {
  return blocks
    .filter((b) => (b.type === 'web_search_tool_result' || b.type === 'web_fetch_tool_result') && b.content && !Array.isArray(b.content) && b.content.error_code)
    .map((b) => b.content.error_code);
}
