import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";

let runId = 0;
// In-flight edit proposals keyed by globally-unique edit_id; value is { resolve, reject }.
const pendingProposals = new Map();
let editIdCounter = 0;

// Re-seed preamble built from the {type:'seed'} line; prepended to the first
// prompt only. Subsequent prompts rely on the SDK's own compaction.
let seedPreamble = "";

function writeLine(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function buildContextPreamble(context) {
  if (!context) return "";
  const parts = [];
  if (context.active_path) parts.push(`Open file: ${context.active_path}`);
  if (context.selection) {
    const s = context.selection;
    parts.push(
      `Selection (L${s.start_line}:${s.start_col}–L${s.end_line}:${s.end_col}):\n${s.text}`
    );
  }
  if (context.recent_edits?.length) {
    parts.push(
      `Recently edited: ${context.recent_edits.map((e) => e.path).join(", ")}`
    );
  }
  return parts.length ? `[Editor context]\n${parts.join("\n")}\n\n` : "";
}

// Compute what the file will look like after the tool runs.
// Write replaces the whole file (and creates it if absent); Edit splices the
// first old_string occurrence — throws if the file is missing or it's absent.
function computeNewContent(toolName, input) {
  if (toolName === "Write") {
    return input.content;
  }
  const original = readFileSync(resolve(process.cwd(), input.path), "utf8");
  const idx = original.indexOf(input.old_string);
  if (idx === -1) throw new Error(`old_string not found in ${input.path}`);
  return original.slice(0, idx) + input.new_string + original.slice(idx + input.old_string.length);
}

// Build a per-run tool gate that attributes proposals to the run that owns it,
// so concurrent prompts can't misattribute each other's edits.
function makeCanUseTool(runId) {
  return async (toolName, input) => {
    if (toolName !== "Edit" && toolName !== "Write") {
      return { behavior: "allow" };
    }

    let newContent;
    try {
      newContent = computeNewContent(toolName, input);
    } catch (err) {
      return { behavior: "deny", message: `Cannot preview edit: ${err.message}` };
    }

    const editId = ++editIdCounter;
    writeLine({
      run_id: runId,
      type: "propose_edit",
      edit_id: editId,
      path: input.path,
      new_content: newContent,
    });

    const decision = await new Promise((res, rej) => {
      pendingProposals.set(editId, { resolve: res, reject: rej });
    });
    pendingProposals.delete(editId);

    if (decision === "accepted") {
      return {
        behavior: "deny",
        message: `User accepted the edit. The file ${input.path} now reflects the change.`,
      };
    }
    return {
      behavior: "deny",
      message: `User rejected the edit to ${input.path}. No changes were written.`,
    };
  };
}

async function runPrompt(text, context) {
  const currentRunId = runId++;
  const contextPart = buildContextPreamble(context);
  // Consume the seed preamble exactly once — cleared after the first prompt.
  const seed = seedPreamble;
  seedPreamble = "";
  const prompt = seed + contextPart + text;
  try {
    for await (const message of query({
      prompt,
      options: {
        cwd: process.cwd(),
        includePartialMessages: true,
        allowedTools: ["Read", "Glob", "Grep", "Edit", "Write"],
        canUseTool: makeCanUseTool(currentRunId),
      },
    })) {
      writeLine({ run_id: currentRunId, ...message });
    }
  } catch (err) {
    writeLine({
      run_id: currentRunId,
      type: "error",
      message: String(err?.message ?? err),
    });
  }
}

// Run the summarize query entirely internally: its SDK turns must never reach
// the host's stdout, or they'd be persisted as chat history and shown in the
// chat pane. Only the final {type:'session_summary'} line is emitted.
async function handleSummarize() {
  let summary = "";
  try {
    for await (const message of query({
      prompt:
        "Summarize this conversation so it can re-seed a future session: key goals, decisions, and current state, in one short paragraph.",
      options: {
        cwd: process.cwd(),
        allowedTools: [],
      },
    })) {
      if (message.type === "assistant") {
        const content = message.message?.content ?? [];
        for (const block of content) {
          if (block.type === "text") summary += block.text;
        }
      }
    }
  } catch {
    // Best-effort — emit an empty summary so the reader still gets the line.
  }
  writeLine({ type: "session_summary", summary });
  // summarize is only sent during shutdown; exit so the host's stdout closes
  // and the Rust reader thread sees EOF and self-cleans the agent slot.
  process.exit(0);
}

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return;
  }

  if (parsed?.type === "seed") {
    // Build a one-time preamble prepended to the first runPrompt call.
    const parts = ["[Resuming session]"];
    if (parsed.summary) parts.push(`Prior-sessions summary: ${parsed.summary}`);
    if (parsed.recent?.length) {
      parts.push(
        "Recent messages:\n" +
          parsed.recent.map((m) => `${m.role}: ${m.content}`).join("\n")
      );
    }
    seedPreamble = parts.join("\n") + "\n\n";
    return;
  }

  if (parsed?.type === "prompt" && typeof parsed.text === "string") {
    runPrompt(parsed.text, parsed.context ?? null);
    return;
  }

  if (parsed?.type === "resolve_edit" && typeof parsed.edit_id === "number") {
    const pending = pendingProposals.get(parsed.edit_id);
    if (pending) pending.resolve(parsed.decision);
    return;
  }

  if (parsed?.type === "summarize") {
    handleSummarize();
    return;
  }
});

rl.on("close", () => {});
