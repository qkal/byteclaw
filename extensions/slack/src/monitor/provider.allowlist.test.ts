import { describe, expect, it } from "vitest";
import { __testing } from "./provider.js";

describe("slack allowlist log formatting", () => {
  it("prints channel names alongside ids", () => {
    expect(
      __testing.formatSlackChannelResolved({
        id: "C0AQXEG6QFJ",
        input: "C0AQXEG6QFJ",
        name: "openclawtest",
        resolved: true,
      }),
    ).toBe("C0AQXEG6QFJ→openclawtest (id:C0AQXEG6QFJ)");
  });

  it("prints user names alongside ids", () => {
    expect(
      __testing.formatSlackUserResolved({
        id: "U090HHQ029J",
        input: "U090HHQ029J",
        name: "steipete",
        resolved: true,
      }),
    ).toBe("U090HHQ029J→steipete (id:U090HHQ029J)");
  });
});
