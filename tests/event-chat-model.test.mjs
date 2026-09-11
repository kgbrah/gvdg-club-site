import assert from "node:assert/strict";
import test from "node:test";

import { mergeChatMessages, normalizeChatMessage } from "../src/shared/event-chat-model.js";

test("normalizeChatMessage keeps author and body, drops empties", () => {
  assert.equal(normalizeChatMessage(null), null);
  assert.equal(normalizeChatMessage({ author_name: "Pat", body: "   " }), null);
  assert.deepEqual(normalizeChatMessage({ id: 3, author_name: "Pat", body: "  parked it  ", created_at: "2026-09-11 22:00:00" }), {
    authorName: "Pat",
    body: "parked it",
    createdAt: "2026-09-11 22:00:00",
    id: "3",
  });
});

test("mergeChatMessages de-dupes by id", () => {
  const first = normalizeChatMessage({ id: 1, author_name: "Pat", body: "go" });
  const same = normalizeChatMessage({ id: 1, author_name: "Pat", body: "go" });
  const next = normalizeChatMessage({ id: 2, author_name: "TJ", body: "already did" });
  assert.deepEqual(mergeChatMessages([first], [same, next]).map((row) => row.id), ["1", "2"]);
});
