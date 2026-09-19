export interface ChatMessage { role: "system" | "user" | "assistant" | "tool"; content: string; toolName?: string; }

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: Array<{ name: string; description: string; schema: Record<string, unknown> }>;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface LLMEvent {
  type: "text" | "tool_call" | "done" | "usage";
  text?: string;
  toolCall?: { id: string; name: string; args: Record<string, unknown> };
  usage?: { inputTokens: number; outputTokens: number };
}

export interface LLMProvider {
  id: string;
  name: string;
  chat(request: ChatRequest): AsyncIterable<LLMEvent>;
  models(): Promise<string[]>;
  health(): Promise<boolean>;
}
