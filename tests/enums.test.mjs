// The front-end and back-end enum modules must export exactly the same values.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as front from "../js/enums.js";
import * as back from "../api/_lib/enums.js";

test("js/enums.js and api/_lib/enums.js export identical names and values", () => {
  assert.deepEqual(Object.keys(back).sort(), Object.keys(front).sort());
  for (const name of Object.keys(front)) assert.deepEqual(back[name], front[name], name);
});

test("enum arrays are non-empty and free of duplicates", () => {
  for (const [name, value] of Object.entries(back)) {
    if (!Array.isArray(value)) continue;
    assert.ok(value.length > 0, name);
    assert.equal(new Set(value).size, value.length, `${name} has duplicates`);
  }
});

test("DEFAULT_APPEARANCE only uses valid enum values", () => {
  const a = back.DEFAULT_APPEARANCE;
  assert.ok(back.CREATURES.includes(a.creature));
  assert.ok(back.HAIR_STYLES.includes(a.hair.style));
  assert.ok(back.TOP_KINDS.includes(a.top.kind));
  assert.ok(back.BOTTOM_KINDS.includes(a.bottom.kind));
  assert.ok(back.HEADWEAR.includes(a.headwear));
  assert.ok(back.ACCESSORIES.includes(a.accessory));
  assert.ok(back.HOLDING.includes(a.holding));
});
