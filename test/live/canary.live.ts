import { expect, test } from "vitest";

// If this file ever runs under `npm test`, the main vitest config has started
// picking up live tests; it must fail in that case.
test("live tests run only via npm run test:live", () => {
  expect(process.env.ISTHISAI_LIVE).toBe("1");
});
