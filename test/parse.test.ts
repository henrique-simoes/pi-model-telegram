import assert from "node:assert/strict";
import { lastUserText, escapeKey, sanitize } from "../extensions/pi-model-telegram.ts";

// pi-chat batches inbound messages; the command is the newest line.
const batched = [
  "- [2026-09-04T20:00:00Z] [uid:111] Luiz: hello there",
  "- [2026-09-04T20:00:05Z] [uid:111] Luiz: /model claude",
].join("\n");
assert.equal(lastUserText(batched), "/model claude");

// single message
assert.equal(lastUserText("- [t] [uid:1] Ana: /login"), "/login");

// attachment lines must not be mistaken for the command
const withAttachment = [
  "- [t] [uid:1] Ana: /thinking",
  "  attachments:",
  "  - /workspace/incoming/a.png (image/png)",
].join("\n");
assert.equal(lastUserText(withAttachment), "/thinking");

// names containing spaces still parse
assert.equal(lastUserText("- [t] [uid:9] Maria Silva: /help"), "/help");

// text containing a colon survives intact
assert.equal(lastUserText("- [t] [uid:9] Bo: ratio 3:1 please"), "ratio 3:1 please");

// non-transcript text yields nothing
assert.equal(lastUserText("just a bare string"), undefined);

// key escaping: pi treats leading $ and ! as interpolation/command
assert.equal(escapeKey("$secret"), "$$secret");
assert.equal(escapeKey("!secret"), "$!secret");
assert.equal(escapeKey("sk-ant-abc"), "sk-ant-abc");

// conversation id sanitisation mirrors pi-chat's tmuxSafeName
assert.equal(sanitize("telegram-bearino:dm-awahe"), "telegram-bearino_dm-awahe");

console.log("all parser tests passed");
