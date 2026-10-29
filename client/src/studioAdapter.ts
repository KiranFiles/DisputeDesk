import type { AgAiEvent, AgAiOutputItem, AgLlmAdapter, AgLlmRequest, AgLlmResponse } from "ag-studio";

async function fetchTurn(endpoint: string, request: AgLlmRequest, signal?: AbortSignal): Promise<AgLlmResponse> {
  const failed = (message: string): AgLlmResponse => ({
    id: `failed-${Date.now()}`,
    createdAt: Date.now(),
    status: signal?.aborted ? "cancelled" : "failed",
    output: [],
    error: { code: "request_failed", message },
  });

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return failed(body.error ?? `Request failed (${res.status})`);
    return body as AgLlmResponse;
  } catch (err) {
    return failed(err instanceof Error ? err.message : "Network error");
  }
}

/** Routes Studio agent turns through the DisputeDesk server so the AI key never reaches the browser. */
export function serverAdapter(endpoint: string): AgLlmAdapter {
  return {
    executeTurn(request, options) {
      const complete = fetchTurn(endpoint, request, options?.signal);

      async function* stream(): AsyncGenerator<AgAiEvent> {
        const response = await complete;
        for (const item of response.output as AgAiOutputItem[]) {
          if (item.type === "message") {
            const delta = item.content.map((part) => (part.type === "text" ? part.text : part.refusal)).join("");
            yield { type: "TEXT_MESSAGE_CHUNK", messageId: item.id, role: "assistant", delta };
          } else if (item.type === "function_call") {
            yield { type: "TOOL_CALL_CHUNK", toolCallId: item.callId, toolCallName: item.name, delta: item.arguments };
          }
        }
      }

      return { stream: stream(), complete };
    },
  };
}
