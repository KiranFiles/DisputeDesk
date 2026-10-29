import type OpenAI from "openai";
import { z } from "zod";
import { AiError, getClient } from "./agent.js";
import { config } from "./config.js";

const Obj = z.record(z.string(), z.unknown());

const TurnRequest = z.object({
  input: z.array(Obj).max(500),
  instructions: z.string().max(100_000).optional(),
  tools: z
    .array(z.object({ name: z.string().max(100), description: z.string().max(10_000), parameters: Obj, kind: z.string().optional() }))
    .max(64)
    .optional(),
  toolChoice: z.union([z.enum(["auto", "none", "required"]), z.object({ name: z.string().max(100) })]).optional(),
  responseFormat: z.union([
    z.object({ type: z.literal("text") }),
    z.object({ type: z.literal("json"), name: z.string().max(64), schema: Obj }),
  ]),
});

type Message = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type AssistantMessage = OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam;
type ToolCall = OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall;

const isGemini = config.aiProvider === "gemini";

const textOf = (content: unknown) =>
  Array.isArray(content)
    ? content.map((part) => (part?.type === "text" ? String(part.text) : part?.type === "refusal" ? String(part.refusal) : "")).join("")
    : "";

/** Gemini's OpenAI-compatible endpoint rejects $ref/$defs and additionalProperties, so inline them. */
function geminiSchema(schema: unknown, defs: Record<string, unknown> = {}, depth = 0): unknown {
  if (Array.isArray(schema)) return schema.map((s) => geminiSchema(s, defs, depth));
  if (!schema || typeof schema !== "object") return schema;
  const node = schema as Record<string, unknown>;
  const localDefs = { ...defs, ...((node.$defs as Record<string, unknown> | undefined) ?? {}) };
  const ref = typeof node.$ref === "string" ? node.$ref.replace("#/$defs/", "") : null;
  if (ref && localDefs[ref] && depth < 12) return geminiSchema(localDefs[ref], localDefs, depth + 1);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "$defs" || key === "$ref" || key === "$schema" || key === "additionalProperties") continue;
    out[key] = geminiSchema(value, localDefs, depth);
  }
  return out;
}

function toMessages(input: Record<string, unknown>[], instructions: string | undefined): Message[] {
  const messages: Message[] = [];
  const results = new Map<string, string>();
  if (instructions) messages.push({ role: "system", content: instructions });

  for (const item of input) {
    if (item.type === "function_call_output") results.set(String(item.callId), String(item.output ?? ""));
    else if (item.type === "function_call" && typeof item.result === "string") results.set(String(item.callId), item.result);
  }

  for (const item of input) {
    if (item.type === "message") {
      const role = item.role === "assistant" ? "assistant" : item.role === "system" ? "system" : "user";
      messages.push({ role, content: textOf(item.content) } as Message);
    } else if (item.type === "function_call") {
      const call: ToolCall = {
        id: String(item.callId),
        type: "function",
        function: { name: String(item.name), arguments: String(item.arguments || "{}") },
      };
      const last = messages.at(-1);
      if (last?.role === "assistant") ((last as AssistantMessage).tool_calls ??= []).push(call);
      else messages.push({ role: "assistant", content: null, tool_calls: [call] });
    }
  }

  // Every tool call needs an immediately following tool message.
  return messages.flatMap((message) => {
    if (message.role !== "assistant" || !message.tool_calls?.length) return [message];
    const replies = message.tool_calls
      .filter((call): call is ToolCall => call.type === "function")
      .map<Message>((call) => ({ role: "tool", tool_call_id: call.id, content: results.get(call.id) ?? '{"error":"No result recorded"}' }));
    return [message, ...replies];
  });
}

/** One LLM turn for AG Studio's agents; the API key stays on the server. */
export async function studioLlmTurn(body: unknown) {
  if (!config.aiKey) throw new AiError("AI is not configured on the server");
  const req = TurnRequest.parse(body);

  const tools = (req.tools ?? [])
    .filter((tool) => !tool.kind || tool.kind === "client")
    .map<OpenAI.Chat.Completions.ChatCompletionTool>((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: (isGemini ? geminiSchema(tool.parameters) : tool.parameters) as Record<string, unknown> },
    }));

  const jsonFormat = req.responseFormat.type === "json" ? req.responseFormat : null;
  let instructions = req.instructions;
  if (jsonFormat && isGemini) {
    instructions = `${instructions ?? ""}\n\nReply with ONLY a JSON object (no markdown) matching this JSON schema:\n${JSON.stringify(jsonFormat.schema)}`;
  }

  let completion;
  try {
    completion = await getClient().chat.completions.create({
      model: config.aiModel,
      messages: toMessages(req.input, instructions),
      temperature: 0.2,
      ...(tools.length && {
        tools,
        tool_choice: typeof req.toolChoice === "object" ? { type: "function", function: { name: req.toolChoice.name } } : (req.toolChoice ?? "auto"),
      }),
      ...(jsonFormat && !isGemini && { response_format: { type: "json_schema", json_schema: { name: jsonFormat.name, schema: jsonFormat.schema, strict: false } } }),
    });
  } catch (err) {
    throw new AiError("AI service request failed", { cause: err });
  }

  const message = completion.choices[0]?.message;
  if (!message) throw new AiError("AI returned no message");

  const output: unknown[] = [];
  if (message.content) {
    output.push({ id: `${completion.id}-msg`, kind: "output", type: "message", role: "assistant", status: "completed", content: [{ type: "text", text: message.content, annotations: [] }] });
  }
  for (const call of message.tool_calls ?? []) {
    if (call.type !== "function") continue;
    output.push({ id: call.id, kind: "output", type: "function_call", callId: call.id, name: call.function.name, arguments: call.function.arguments || "{}", status: "completed" });
  }

  return { id: completion.id, createdAt: Date.now(), status: "completed", output, model: completion.model };
}
