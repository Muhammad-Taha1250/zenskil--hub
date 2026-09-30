import {
  LlmCompletion,
  LlmMessage,
  LlmProvider,
  LlmToolDefinition,
} from '../llm-provider.interface';

// Deterministic stub used when no AI_API_KEY is configured (or when the owner
// wants a fully deterministic assistant). It never invents: it routes the
// message to exactly ONE read-only tool based on intent, and the AI service
// answers from that tool's result — otherwise it escalates to a human.
// No model is called, no prices are ever recalled from training.

// Most specific first: an order number in the text always wins. Canonical
// format is ZSH-YYYYMMDD-XXXXX, but customers type variants (ZSH-AI-00001).
const ORDER_RE = /ZSH-(?:\d{8}|[A-Z0-9]{2,8})-\d{2,8}/i;
const PRICE_RE = /\b(price|prices|pricing|qeemat|keemat|qimat|cost|fees|charges?|kitna|kitne|paisa|rate|plan)\b/i;
const SUBSCRIPTION_RE = /\b(subscri\w*|expir\w*|renew\w*|membership|my plan|mera plan)/i;

export function detectStubIntent(text: string): 'get_order' | 'get_plan' | 'get_subscription_status' | 'search_knowledge_base' {
  if (ORDER_RE.exec(text)) return 'get_order';
  if (SUBSCRIPTION_RE.test(text)) return 'get_subscription_status';
  if (PRICE_RE.test(text)) return 'get_plan';
  return 'search_knowledge_base';
}

export function stubToolCall(tool: string, query: string): LlmCompletion['toolCalls'][number] {
  const args: Record<string, unknown> =
    tool === 'get_order'
      ? { orderNumber: ORDER_RE.exec(query)?.[0]?.toUpperCase() }
      : tool === 'search_knowledge_base'
        ? { query: query.slice(0, 500), topK: 3 }
        : {};
  return {
    id: `stub-${tool}-1`,
    name: tool,
    argumentsJson: JSON.stringify(args),
  };
}

export class StubProvider implements LlmProvider {
  readonly providerName = 'stub-deterministic';

  async complete(messages: LlmMessage[], tools: LlmToolDefinition[]): Promise<LlmCompletion> {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    const query = (lastUser?.content ?? '').slice(0, 500);
    if (!query.trim()) {
      return {
        text: '__ESCALATE__',
        toolCalls: [{ id: 'stub-esc-1', name: 'request_human_agent', argumentsJson: JSON.stringify({ reason: 'empty message' }) }],
      };
    }
    const tool = detectStubIntent(query);
    if (!tools.some((t) => t.name === tool)) {
      return {
        text: '__ESCALATE__',
        toolCalls: [{ id: 'stub-esc-2', name: 'request_human_agent', argumentsJson: JSON.stringify({ reason: `tool ${tool} unavailable` }) }],
      };
    }
    // Ask the orchestrator to run exactly one tool call.
    return { text: '', toolCalls: [stubToolCall(tool, query)] };
  }
}
