// Provider-agnostic LLM interface (spec §26, §54).
// Day one: StubProvider (deterministic, KB-only) is the default.
// When the owner supplies AI_API_KEY, OpenAICompatibleProvider takes over.
// Swapping vendors = implementing this interface; nothing else changes.

export interface LlmToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

export interface LlmToolCallRequest {
  id: string;
  name: string;
  argumentsJson: string;
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
  toolCalls?: LlmToolCallRequest[];
}

export interface LlmCompletion {
  text: string;
  toolCalls: LlmToolCallRequest[];
  usage?: { promptTokens?: number; completionTokens?: number };
  rawModel?: string;
}

export interface LlmProvider {
  readonly providerName: string;
  complete(messages: LlmMessage[], tools: LlmToolDefinition[], opts?: { maxTokens?: number }): Promise<LlmCompletion>;
}
