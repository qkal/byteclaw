import { describe, expect, it } from "vitest";
import {
  createActionCard,
  createCarousel,
  createDeviceControlCard,
  createEventCard,
  createImageCard,
  createInfoCard,
  createListCard,
} from "./flex-templates.js";
import {
  createButtonTemplate,
  createCarouselColumn,
  createConfirmTemplate,
  createImageCarousel,
  createImageCarouselColumn,
  createProductCarousel,
  createTemplateCarousel,
  messageAction,
} from "./template-messages.js";

describe("createConfirmTemplate", () => {
  it("truncates text to 240 characters", () => {
    const longText = "x".repeat(300);
    const template = createConfirmTemplate(longText, messageAction("Yes"), messageAction("No"));

    expect((template.template as { text: string }).text.length).toBe(240);
  });
});

describe("createButtonTemplate", () => {
  it("limits actions to 4", () => {
    const actions = Array.from({ length: 6 }, (_, i) => messageAction(`Button ${i}`));
    const template = createButtonTemplate("Title", "Text", actions);

    expect((template.template as { actions: unknown[] }).actions.length).toBe(4);
  });

  it("truncates title to 40 characters", () => {
    const longTitle = "x".repeat(50);
    const template = createButtonTemplate(longTitle, "Text", [messageAction("OK")]);

    expect((template.template as { title: string }).title.length).toBe(40);
  });

  it("truncates text to 60 chars when no thumbnail is provided", () => {
    const longText = "x".repeat(100);
    const template = createButtonTemplate("Title", longText, [messageAction("OK")]);

    expect((template.template as { text: string }).text.length).toBe(60);
  });

  it("keeps longer text when thumbnail is provided", () => {
    const longText = "x".repeat(100);
    const template = createButtonTemplate("Title", longText, [messageAction("OK")], {
      thumbnailImageUrl: "https://example.com/thumb.jpg",
    });

    expect((template.template as { text: string }).text.length).toBe(100);
  });
});

describe("createCarouselColumn", () => {
  it("limits actions to 3", () => {
    const column = createCarouselColumn({
      actions: [
        messageAction("A1"),
        messageAction("A2"),
        messageAction("A3"),
        messageAction("A4"),
        messageAction("A5"),
      ],
      text: "Text",
    });

    expect(column.actions.length).toBe(3);
  });

  it("truncates text to 120 characters", () => {
    const longText = "x".repeat(150);
    const column = createCarouselColumn({ actions: [messageAction("OK")], text: longText });

    expect(column.text.length).toBe(120);
  });
});

describe("carousel column limits", () => {
  it.each([
    {
      createTemplate: () =>
        createTemplateCarousel(
          Array.from({ length: 15 }, () =>
            createCarouselColumn({ actions: [messageAction("OK")], text: "Text" }),
          ),
        ),
    },
    {
      createTemplate: () =>
        createImageCarousel(
          Array.from({ length: 15 }, (_, i) =>
            createImageCarouselColumn(`https://example.com/${i}.jpg`, messageAction("View")),
          ),
        ),
    },
  ])("limits columns to 10", ({ createTemplate }) => {
    const template = createTemplate();
    expect((template.template as { columns: unknown[] }).columns.length).toBe(10);
  });
});

describe("createProductCarousel", () => {
  it.each([
    {
      actionLabel: "Buy",
      actionUrl: "https://shop.com/buy",
      description: "Desc",
      expectedType: "uri",
      title: "Product",
    },
    {
      actionData: "product_id=123",
      actionLabel: "Select",
      description: "Desc",
      expectedType: "postback",
      title: "Product",
    },
  ])("uses expected action type for product action", ({ expectedType, ...item }) => {
    const template = createProductCarousel([item]);
    const {columns} = (template.template as { columns: { actions: Array<{ type: string }> }[] });
    expect(columns[0].actions[0].type).toBe(expectedType);
  });
});

describe("flex cards", () => {
  it("includes footer when provided", () => {
    const card = createInfoCard("Title", "Body", "Footer text");

    const footer = card.footer as { contents: { text: string }[] };
    expect(footer.contents[0].text).toBe("Footer text");
  });

  it("limits list items to 8", () => {
    const items = Array.from({ length: 15 }, (_, i) => ({ title: `Item ${i}` }));
    const card = createListCard("List", items);

    const body = card.body as { contents: { type: string; contents?: unknown[] }[] };
    const listBox = body.contents[2] as { contents: unknown[] };
    expect(listBox.contents.length).toBe(8);
  });

  it("includes image-card body text when provided", () => {
    const card = createImageCard("https://example.com/img.jpg", "Title", "Body text");

    const body = card.body as { contents: { text: string }[] };
    expect(body.contents.length).toBe(2);
    expect(body.contents[1].text).toBe("Body text");
  });

  it("limits action-card actions to 4", () => {
    const actions = Array.from({ length: 6 }, (_, i) => ({
      action: { label: `A${i}`, text: `action${i}`, type: "message" as const },
      label: `Action ${i}`,
    }));
    const card = createActionCard("Title", "Body", actions);

    const footer = card.footer as { contents: unknown[] };
    expect(footer.contents.length).toBe(4);
  });

  it("limits carousels to 12 bubbles", () => {
    const bubbles = Array.from({ length: 15 }, (_, i) => createInfoCard(`Card ${i}`, `Body ${i}`));
    const carousel = createCarousel(bubbles);

    expect(carousel.contents.length).toBe(12);
  });

  it("limits device controls to 6", () => {
    const card = createDeviceControlCard({
      controls: Array.from({ length: 10 }, (_, i) => ({
        data: `action=${i}`,
        label: `Control ${i}`,
      })),
      deviceName: "Device",
    });

    const footer = card.footer as { contents: unknown[] };
    expect(footer.contents.length).toBeLessThanOrEqual(3);
  });

  it("keeps event-card optional fields together", () => {
    const card = createEventCard({
      date: "February 15, 2026",
      description: "Annual team building event",
      location: "Mountain View Office",
      time: "9:00 AM - 5:00 PM",
      title: "Team Offsite",
    });

    expect(card.size).toBe("mega");
    const body = card.body as { contents: { type: string }[] };
    expect(body.contents).toHaveLength(3);
  });
});
