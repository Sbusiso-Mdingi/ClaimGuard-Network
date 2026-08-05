import assert from "node:assert/strict";
import test from "node:test";

import { productIdentity } from "../src/product-identity.js";

test("public identity is Sequrin without renaming the internal codename", () => {
  assert.deepEqual(productIdentity, {
    productName: "Sequrin",
    internalCodename: "ClaimGuard",
    pronunciation: "Securing",
    descriptor: "Secure Integrity Network",
  });
  assert.equal(Object.isFrozen(productIdentity), true);
});
