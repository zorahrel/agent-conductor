import { promises } from 'fs';

// src/jsonl/parser.ts
var DEFAULT_TAIL_BYTES = 256e3;
async function readJsonlTailLines(path, maxBytes = DEFAULT_TAIL_BYTES) {
  let fh = null;
  try {
    fh = await promises.open(path, "r");
    const st = await fh.stat();
    const toRead = Math.min(st.size, maxBytes);
    const offset = Math.max(0, st.size - toRead);
    const buf = Buffer.alloc(toRead);
    await fh.read(buf, 0, toRead, offset);
    const text = buf.toString("utf8");
    return text.split("\n").filter((l) => l.trim().length > 0);
  } catch {
    return [];
  } finally {
    if (fh) await fh.close().catch(() => void 0);
  }
}
function safeParse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}
async function extractToolUseEvents(path, lastNTurns = 5) {
  const lines = await readJsonlTailLines(path);
  if (lines.length === 0) return [];
  const allEvents = [];
  let turnIndex = -1;
  for (const line of lines) {
    const obj = safeParse(line);
    if (!obj) continue;
    if (obj.type === "assistant") {
      turnIndex++;
      const blocks = obj.message?.content ?? [];
      for (const block of blocks) {
        if (block.type === "tool_use" && typeof block.name === "string") {
          allEvents.push({
            name: block.name,
            inputKeys: block.input ? Object.keys(block.input) : [],
            turnIndex
          });
        }
      }
    }
  }
  const totalTurns = turnIndex + 1;
  if (totalTurns <= 0) return [];
  const cutoff = Math.max(0, totalTurns - lastNTurns);
  return allEvents.filter((e) => e.turnIndex >= cutoff);
}
async function sumTokens(path) {
  const lines = await readJsonlTailLines(path);
  let input = 0;
  let output = 0;
  let cacheCreation = 0;
  let cacheRead = 0;
  for (const line of lines) {
    const obj = safeParse(line);
    if (obj?.type === "assistant" && obj.message?.usage) {
      const u = obj.message.usage;
      input += u.input_tokens ?? 0;
      output += u.output_tokens ?? 0;
      cacheCreation += u.cache_creation_input_tokens ?? 0;
      cacheRead += u.cache_read_input_tokens ?? 0;
    }
  }
  return {
    input,
    output,
    cacheCreation,
    cacheRead,
    total: input + output + cacheCreation + cacheRead
  };
}
async function countTurns(path) {
  const lines = await readJsonlTailLines(path);
  let count = 0;
  for (const line of lines) {
    const obj = safeParse(line);
    if (obj?.type === "assistant") count++;
  }
  return count;
}
async function extractLastAssistantTurn(transcriptPath) {
  const lines = await readJsonlTailLines(transcriptPath, 256e3);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(lines[i]);
      if (obj.type === "assistant" && obj.message?.role === "assistant") {
        return {
          stop_reason: obj.message.stop_reason ?? null,
          content: obj.message.content ?? [],
          timestamp: obj.timestamp ?? "",
          uuid: obj.uuid ?? ""
        };
      }
    } catch {
    }
  }
  return null;
}
async function extractPendingToolUses(transcriptPath) {
  const lines = await readJsonlTailLines(transcriptPath, 256e3);
  const toolUses = /* @__PURE__ */ new Map();
  const matchedIds = /* @__PURE__ */ new Set();
  for (const raw of lines) {
    try {
      const obj = JSON.parse(raw);
      if (obj.type === "assistant" && Array.isArray(obj.message?.content)) {
        for (const block of obj.message.content) {
          if (block?.type === "tool_use" && typeof block.id === "string") {
            toolUses.set(block.id, {
              id: block.id,
              name: typeof block.name === "string" ? block.name : "",
              input: block.input ?? null
            });
          }
        }
      }
      if (obj.type === "user" && Array.isArray(obj.message?.content)) {
        for (const block of obj.message.content) {
          if (block?.type === "tool_result" && typeof block.tool_use_id === "string") {
            matchedIds.add(block.tool_use_id);
          }
        }
      }
    } catch {
    }
  }
  return [...toolUses.values()].filter((tu) => !matchedIds.has(tu.id));
}
async function getStopReason(transcriptPath) {
  const last = await extractLastAssistantTurn(transcriptPath);
  return last?.stop_reason ?? null;
}

export { countTurns, extractLastAssistantTurn, extractPendingToolUses, extractToolUseEvents, getStopReason, readJsonlTailLines, sumTokens };
//# sourceMappingURL=index.js.map
//# sourceMappingURL=index.js.map