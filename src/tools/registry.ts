import * as z from "zod";
import type { ToolSpec } from "../provider/types.js";

export type ToolDefinition<S extends z.ZodType = z.ZodType> = {
  name: string;
  description: string;
  input: S;
  handler: (args: z.infer<S>) => Promise<unknown>;
};

export type ToolFailure =
  | { ok: false; error: "VALIDATION_ERROR"; issues: { path: string; message: string }[] }
  | { ok: false; error: "UNKNOWN_TOOL" | "TOOL_TIMEOUT" | "TOOL_FAILED" };

/** Keeps the handler's argument type tied to its schema. */
export function defineTool<S extends z.ZodType>(def: ToolDefinition<S>): ToolDefinition {
  return def as unknown as ToolDefinition;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  constructor(
    tools: ToolDefinition[],
    private readonly timeoutMs = 3000,
  ) {
    for (const tool of tools) {
      if (this.tools.has(tool.name)) throw new Error(`duplicate tool: ${tool.name}`);
      this.tools.set(tool.name, tool);
    }
  }

  specs(): ToolSpec[] {
    return [...this.tools.values()].map((t) => {
      // Providers expect a bare JSON Schema object; the $schema dialect marker is noise to them.
      const parameters = z.toJSONSchema(t.input) as Record<string, unknown>;
      delete parameters.$schema;
      return { name: t.name, description: t.description, parameters };
    });
  }

  /**
   * Validates and runs a tool call that came from a model. Never throws: every failure becomes a
   * structured result that is sent back to the model so the conversation can recover.
   */
  async execute(name: string, argumentsJson: string): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) return { ok: false, error: "UNKNOWN_TOOL" } satisfies ToolFailure;

    let raw: unknown;
    try {
      raw = argumentsJson.trim() === "" ? {} : JSON.parse(argumentsJson);
    } catch {
      return {
        ok: false,
        error: "VALIDATION_ERROR",
        issues: [{ path: "", message: "arguments are not valid JSON" }],
      } satisfies ToolFailure;
    }

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<ToolFailure>((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, error: "TOOL_TIMEOUT" }), this.timeoutMs);
    });
    try {
      // Async so schemas with async refinements work; inside the try because a refinement can throw.
      const parsed = await tool.input.safeParseAsync(raw);
      if (!parsed.success) {
        return {
          ok: false,
          error: "VALIDATION_ERROR",
          issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        } satisfies ToolFailure;
      }
      const result = await Promise.race([tool.handler(parsed.data), timeout]);
      // Adapters serialize the result with JSON.stringify; fail here (e.g. BigInt) rather than in the adapter.
      JSON.stringify(result);
      return result;
    } catch {
      return { ok: false, error: "TOOL_FAILED" } satisfies ToolFailure;
    } finally {
      clearTimeout(timer);
    }
  }
}
