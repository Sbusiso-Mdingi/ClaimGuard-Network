import assert from "node:assert/strict";
import test from "node:test";

import {
  buildControlPlaneConnectionOptions,
} from "../src/client.js";

test("control-plane connections serialize and parse timestamps as UTC", () => {
  const options =
    buildControlPlaneConnectionOptions(
      "mysql://user:password@localhost:3306/control_plane",
    );

  assert.equal(
    options.timezone,
    "Z",
  );
});
