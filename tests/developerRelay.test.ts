import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDeveloperRelayContent,
  parseDeveloperRelayMessage,
} from "../src/developerRelayFormat.js";

test("defaults relay messages to the private thread", () => {
  assert.deepEqual(
    parseDeveloperRelayMessage("Please review https://example.com/pr/42"),
    {
      ok: true,
      destination: "thread",
      body: "Please review https://example.com/pr/42",
    },
  );
});

test("recognizes explicit channel and thread destinations", () => {
  assert.deepEqual(
    parseDeveloperRelayMessage("channel: release notes https://example.com/release"),
    {
      ok: true,
      destination: "channel",
      body: "release notes https://example.com/release",
    },
  );
  assert.deepEqual(
    parseDeveloperRelayMessage("THREAD: https://example.com/private"),
    {
      ok: true,
      destination: "thread",
      body: "https://example.com/private",
    },
  );
});

test("requires both content and a link", () => {
  assert.equal(parseDeveloperRelayMessage("channel:").ok, false);
  assert.equal(parseDeveloperRelayMessage("A message without a URL").ok, false);
  assert.equal(parseDeveloperRelayMessage("www.example.com/docs").ok, true);
});

test("escapes attribution formatting and neutralizes username mentions", () => {
  const content = buildDeveloperRelayContent(
    "@everyone **maintainer**",
    "123456789012345678",
    "See https://example.com",
  );

  assert.ok(content.startsWith("**From @​everyone \\*\\*maintainer\\*\\*"));
  assert.match(content, /123456789012345678/);
  assert.match(content, /See https:\/\/example\.com$/);
});
