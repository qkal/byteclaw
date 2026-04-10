import { describe, expect, it } from "vitest";
import { cleanBlocksForDescendant } from "./docx-table-ops.js";

describe("cleanBlocksForDescendant", () => {
  it("removes parent links and read-only table fields while normalizing table cells", () => {
    const blocks = [
      {
        block_id: "table-1",
        block_type: 31,
        children: "cell-1",
        parent_id: "parent-1",
        table: {
          cells: ["cell-1"],
          merge_info: [{ col_span: 1, row_span: 1 }],
          property: {
            column_size: 1,
            column_width: [240],
            row_size: 1,
          },
        },
      },
      {
        block_id: "cell-1",
        block_type: 32,
        children: "text-1",
        parent_id: "table-1",
      },
      {
        block_id: "text-1",
        block_type: 2,
        parent_id: "cell-1",
        text: {
          elements: [{ text_run: { content: "hello" } }],
        },
      },
    ];

    const cleaned = cleanBlocksForDescendant(blocks);

    expect(cleaned[0]).not.toHaveProperty("parent_id");
    expect(cleaned[1]).not.toHaveProperty("parent_id");
    expect(cleaned[2]).not.toHaveProperty("parent_id");

    expect(cleaned[0]?.table).toEqual({
      property: {
        column_size: 1,
        column_width: [240],
        row_size: 1,
      },
    });
    expect(cleaned[1]?.children).toEqual(["text-1"]);
  });
});
