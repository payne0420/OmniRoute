import test from "node:test";
import assert from "node:assert/strict";
import { newStreamCtx, processFrame, type StreamCtx } from "../../open-sse/executors/cursor";

// ─── Wire-format helpers (mirror the encoder's primitives) ─────────────────

function v(n: number): Buffer {
  const out: number[] = [];
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n);
  return Buffer.from(out);
}
function tag(field: number, wireType: number): Buffer {
  return v((field << 3) | wireType);
}
function lenPrefixed(field: number, payload: Buffer): Buffer {
  return Buffer.concat([tag(field, 2), v(payload.length), payload]);
}

// AgentServerMessage { interaction_update (1): { text_delta (1): { text (1): str } } }
function buildTextDeltaPayload(text: string): Buffer {
  const tdu = lenPrefixed(1, Buffer.from(text, "utf8"));
  const iu = lenPrefixed(1, tdu);
  return lenPrefixed(1, iu);
}

// AgentServerMessage { interaction_update (1): { turn_ended (14): {} } }
function buildTurnEndedPayload(): Buffer {
  const iu = lenPrefixed(14, Buffer.alloc(0));
  return lenPrefixed(1, iu);
}

// AgentServerMessage { interaction_update (1): { token_delta (8): { count (1): n } } }
function buildTokenDeltaPayload(tokens: number): Buffer {
  const tokDelta = Buffer.concat([tag(1, 0), v(tokens)]);
  const iu = lenPrefixed(8, tokDelta);
  return lenPrefixed(1, iu);
}

// AgentServerMessage { kv_server_message (4): {...} } — empty body
function buildKvServerMessagePayload(): Buffer {
  return lenPrefixed(4, Buffer.alloc(0));
}

// JSON error payload (Connect-RPC error envelope)
function buildJsonErrorPayload(): Buffer {
  return Buffer.from(
    JSON.stringify({
      error: { message: "rate limited", code: "resource_exhausted" },
    }),
    "utf8"
  );
}

// ─── Tests ─────────────────────────────────────────────────────────────────

test("newStreamCtx initializes with empty state", () => {
  const ctx = newStreamCtx("auto", () => {});
  assert.equal(ctx.totalText, "");
  assert.equal(ctx.tokenDelta, 0);
  assert.equal(ctx.endReason, null);
  assert.equal(ctx.emittedRoleChunk, false);
  assert.equal(ctx.midStreamError, null);
  assert.equal(ctx.model, "auto");
  assert.match(ctx.responseId, /^chatcmpl-cursor-/);
});

test("processFrame emits role+content chunks for text deltas", () => {
  const emitted: string[] = [];
  const ctx = newStreamCtx("auto", (s) => emitted.push(s));
  processFrame(buildTextDeltaPayload("hello"), ctx, new Set());
  assert.equal(emitted.length, 2, "role chunk then content chunk");
  // First chunk: role
  const first = JSON.parse(emitted[0].replace(/^data: /, "").trim());
  assert.equal(first.choices[0].delta.role, "assistant");
  // Second chunk: content
  const second = JSON.parse(emitted[1].replace(/^data: /, "").trim());
  assert.equal(second.choices[0].delta.content, "hello");
  assert.equal(ctx.totalText, "hello");
  assert.equal(ctx.receivedText, true);
});

test("processFrame skips role chunk on subsequent text deltas", () => {
  const emitted: string[] = [];
  const ctx = newStreamCtx("auto", (s) => emitted.push(s));
  processFrame(buildTextDeltaPayload("hello "), ctx, new Set());
  processFrame(buildTextDeltaPayload("world"), ctx, new Set());
  assert.equal(emitted.length, 3, "role + 2 content chunks");
  assert.equal(ctx.totalText, "hello world");
});

test("processFrame sets endReason on turn_ended", () => {
  const ctx = newStreamCtx("auto", () => {});
  processFrame(buildTurnEndedPayload(), ctx, new Set());
  assert.equal(ctx.endReason, "turn_ended");
});

test("processFrame accumulates token_delta", () => {
  const ctx = newStreamCtx("auto", () => {});
  processFrame(buildTokenDeltaPayload(42), ctx, new Set());
  processFrame(buildTokenDeltaPayload(13), ctx, new Set());
  assert.equal(ctx.tokenDelta, 55);
});

test("processFrame sets endReason on kv_server_message after text", () => {
  const ctx = newStreamCtx("auto", () => {});
  processFrame(buildTextDeltaPayload("hi"), ctx, new Set());
  processFrame(buildKvServerMessagePayload(), ctx, new Set());
  assert.equal(ctx.endReason, "kv_after_text");
  assert.equal(ctx.kvAfterTextSeen, true);
});

test("processFrame ignores kv_server_message before text (no end signal yet)", () => {
  const ctx = newStreamCtx("auto", () => {});
  processFrame(buildKvServerMessagePayload(), ctx, new Set());
  assert.equal(ctx.endReason, null);
  assert.equal(ctx.kvAfterTextSeen, false);
});

test("processFrame captures mid-stream JSON error", () => {
  const ctx = newStreamCtx("auto", () => {});
  processFrame(buildJsonErrorPayload(), ctx, new Set());
  assert.equal(ctx.endReason, "server_end");
  assert.ok(ctx.midStreamError);
  assert.match(ctx.midStreamError!.message, /rate limited/);
});

test("processFrame JSON error after text terminates without overwriting content", () => {
  const ctx = newStreamCtx("auto", () => {});
  processFrame(buildTextDeltaPayload("partial"), ctx, new Set());
  processFrame(buildJsonErrorPayload(), ctx, new Set());
  assert.equal(ctx.endReason, "server_end");
  assert.equal(ctx.midStreamError, null, "no error overlay when text already streamed");
  assert.equal(ctx.totalText, "partial");
});

test("processFrame doesn't ack same exec_id twice", () => {
  // Simulate request_context appearing twice — only the first should ack.
  // Phase 6 dedup is keyed by kind+execId+execMsgId so request_context and
  // mcp_args sharing an empty execId don't collide.
  const ctx = newStreamCtx("auto", () => {});
  const acked = new Set<string>();

  // Build an exec_request_context payload:
  // ASM { exec_server_message (2): ESM { id (1): 1, exec_id (15): "x", request_context_args (10): {} } }
  function buildRequestContext(execId: string): Buffer {
    const esm = Buffer.concat([
      Buffer.concat([tag(1, 0), v(1)]),
      lenPrefixed(15, Buffer.from(execId, "utf8")),
      lenPrefixed(10, Buffer.alloc(0)),
    ]);
    return lenPrefixed(2, esm);
  }

  processFrame(buildRequestContext("x"), ctx, acked);
  assert.ok(acked.has("exec_request_context:x:1"));
  // Second call doesn't error or change state
  processFrame(buildRequestContext("x"), ctx, acked);
  assert.equal(acked.size, 1);
});

test("StreamCtx custom emit is invoked with full SSE-formatted strings", () => {
  const captured: string[] = [];
  const ctx = newStreamCtx("auto", (s) => captured.push(s));
  processFrame(buildTextDeltaPayload("ok"), ctx, new Set());
  // Each emit ends with \n\n and starts with "data: "
  for (const s of captured) {
    assert.match(s, /^data: /);
    assert.ok(s.endsWith("\n\n"));
  }
});
