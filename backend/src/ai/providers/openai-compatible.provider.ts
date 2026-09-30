import {
  LlmCompletion,
  LlmMessage,
  LlmProvider,
  LlmToolDefinition,
  LlmToolCallRequest,
} from '../llm-provider.interface';

// Any OpenAI-compatible chat-completions endpoint (OpenAI, Azure OpenAI,
// Groq, Together, local Ollama/vLLM, ...). Configured via env, no SDK.
export class OpenAICompatibleProvider implements LlmProvider {
  readonly providerName: string;

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly model: string,
  ) {
    this.providerName = `openai-compatible:${model}`;
  }

  async complete(messages: LlmMessage[], tools: LlmToolDefinition[], opts?: { maxTokens?: number }): Promise<LlmCompletion> {
    const body = {
      model: this.model,
      max_tokens: opts?.maxTokens ?? 500,
      temperature: 0.2,
      messages: messages.map((m) => {
        if (m.role === 'tool') {
          return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
        }
        if (m.role === 'assistant' && m.toolCalls?.length) {
          return {
            role: 'assistant',
            content: m.content || null,
            tool_calls: m.toolCalls.map((t) => ({
              id: t.id,
              type: 'function',
              function: { name: t.name, arguments: t.argumentsJson },
            })),
          };
        }
        return { role: m.role, content: m.content };
      }),
      tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
      tool_choice: 'auto',
    };

    const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`LLM provider error ${res.status}: ${text.slice(0, 300)}`);
    }
    const json = (await res.json()) as {
      choices?: Array<{
        message?: {
          content?: string | null;
          tool_calls?: Array<{ id: string; function?: { name?: string; arguments?: string } }>;
        };
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      model?: string;
    };
    const msg = json.choices?.[0]?.message;
    const toolCalls: LlmToolCallRequest[] = (msg?.tool_calls ?? []).map((t, i) => ({
      id: t.id ?? `tc-${i}`,
      name: t.function?.name ?? '',
      argumentsJson: t.function?.arguments ?? '{}',
    }));
    return {
      text: msg?.content ?? '',
      toolCalls,
      usage: json.usage
        ? { promptTokens: json.usage.prompt_tokens, completionTokens: json.usage.completion_tokens }
        : undefined,
      rawModel: json.model,
    };
  }
}
