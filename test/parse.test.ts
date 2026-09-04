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

import { knownProviders } from "../extensions/pi-model-telegram.ts";

// Bootstrap: works with an empty catalogue, which is the /login case.
const bootstrap = knownProviders([]);
assert.ok(bootstrap.length >= 30, "documented providers must be listed without a catalogue");
assert.ok(bootstrap.some((p) => p.key === "anthropic" && p.label === "Anthropic"));
assert.ok(bootstrap.some((p) => p.key === "google" && p.label === "Google Gemini"));

// Catalogue-only providers are appended, never duplicated.
const merged = knownProviders(["anthropic", "my-local-gateway"]);
assert.equal(merged.filter((p) => p.key === "anthropic").length, 1);
assert.ok(merged.some((p) => p.key === "my-local-gateway"));

console.log("provider bootstrap tests passed");

import { pickCommand, transcriptTexts } from "../extensions/pi-model-telegram.ts";

const COMMANDS = new Set([
  "help", "model", "thinking", "login", "logout", "providers", "whichmodel", "cancel",
]);

// Reproduces the reported failure: several messages arrive before any job
// completes, so pi-chat batches them into one prompt. Reading only the last
// line dropped /login.
const burst = [
  "- [t1] [uid:7] H S: /chat",
  "- [t2] [uid:7] H S: Hey!",
  "- [t3] [uid:7] H S: /login",
  "- [t4] [uid:7] H S: /help",
  "- [t5] [uid:7] H S: Hi",
].join("\n");

assert.equal(transcriptTexts(burst).length, 5);
// last line is chatter, but the newest real command must still be found
assert.equal(pickCommand(burst, COMMANDS), "/help");

// with /help removed, /login is the newest command and must win
const burst2 = [
  "- [t1] [uid:7] H S: Hey!",
  "- [t2] [uid:7] H S: /login",
  "- [t3] [uid:7] H S: Hi",
].join("\n");
assert.equal(pickCommand(burst2, COMMANDS), "/login");

// arguments are preserved
assert.equal(pickCommand("- [t] [uid:7] H S: /model claude opus", COMMANDS), "/model claude opus");

// no command in the batch
assert.equal(pickCommand("- [t] [uid:7] H S: just chatting", COMMANDS), undefined);

// bare (slashless) form still recognised
assert.equal(pickCommand("- [t] [uid:7] H S: help", COMMANDS), "help");

console.log("batch dispatch tests passed");

import { chunk } from "../extensions/pi-model-telegram.ts";

// Full provider list must arrive complete, split across messages if needed.
const long = Array.from({ length: 400 }, (_, i) => `${i + 1}. provider-name-${i} (not authenticated)`).join("\n");
const parts = chunk(long, 3900);
assert.ok(parts.length > 1, "a long list must split");
assert.ok(parts.every((p) => p.length <= 3900), "no part may exceed the Telegram limit");
// nothing lost: every line survives, in order
assert.deepEqual(parts.join("\n").split("\n"), long.split("\n"));

// short text is untouched
assert.deepEqual(chunk("hello"), ["hello"]);

// a single line longer than the limit is still emitted rather than dropped
const huge = "x".repeat(5000);
assert.deepEqual(chunk(huge, 3900), [huge]);

console.log("chunking tests passed");

import { isPendingReply } from "../extensions/pi-model-telegram.ts";

// A numbered picker accepts only a number or cancel; ordinary chat must pass
// through to the model instead of being answered "reply with a number".
const picker = { kind: "login" };
assert.equal(isPendingReply(picker, "2"), true);
assert.equal(isPendingReply(picker, " 15 "), true);
assert.equal(isPendingReply(picker, "cancel"), true);
assert.equal(isPendingReply(picker, "Cancel"), true);
assert.equal(isPendingReply(picker, "Hi!"), false);      // the reported failure
assert.equal(isPendingReply(picker, "Hi?"), false);
assert.equal(isPendingReply(picker, "what is 2 + 2"), false);
assert.equal(isPendingReply(picker, "2 please"), false);

// Free-text steps legitimately take anything, including something chatty.
assert.equal(isPendingReply({ kind: "apikey" }, "sk-ant-whatever"), true);
assert.equal(isPendingReply({ kind: "apikey" }, "Hi!"), true);
assert.equal(isPendingReply({ kind: "endpoint" }, "https://api.example.com/v1"), true);

console.log("pending-gate tests passed");
