import { describe, expect, it } from "vitest";
import { readFields } from "./shared.js";

describe("readFields", () => {
  it.each([
    {
      expected: [{ ref: "6", type: "textbox", value: "hello" }],
      fields: '[{"ref":"6","type":"textbox","value":"hello"}]',
      name: "keeps explicit type",
    },
    {
      expected: [{ ref: "7", type: "text", value: "world" }],
      fields: '[{"ref":"7","value":"world"}]',
      name: "defaults missing type to text",
    },
    {
      expected: [{ ref: "8", type: "text", value: "blank" }],
      fields: '[{"ref":"8","type":"   ","value":"blank"}]',
      name: "defaults blank type to text",
    },
  ])("$name", async ({ fields, expected }) => {
    await expect(readFields({ fields })).resolves.toEqual(expected);
  });

  it("requires ref", async () => {
    await expect(readFields({ fields: '[{"type":"textbox","value":"world"}]' })).rejects.toThrow(
      "fields[0] must include ref",
    );
  });
});
