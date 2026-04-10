import fs from "node:fs/promises";
import path from "node:path";
import { compileMemoryWikiVault } from "./compile.js";
import type { ResolvedMemoryWikiConfig } from "./config.js";
import { appendMemoryWikiLog } from "./log.js";
import { renderMarkdownFence, renderWikiMarkdown, slugifyWikiSegment } from "./markdown.js";
import { initializeMemoryWikiVault } from "./vault.js";

export interface IngestMemoryWikiSourceResult {
  sourcePath: string;
  pageId: string;
  pagePath: string;
  title: string;
  bytes: number;
  created: boolean;
  indexUpdatedFiles: string[];
}

function pathExists(filePath: string): Promise<boolean> {
  return fs
    .access(filePath)
    .then(() => true)
    .catch(() => false);
}

function resolveSourceTitle(sourcePath: string, explicitTitle?: string): string {
  if (explicitTitle?.trim()) {
    return explicitTitle.trim();
  }
  return path.basename(sourcePath, path.extname(sourcePath)).replace(/[-_]+/g, " ").trim();
}

function assertUtf8Text(buffer: Buffer, sourcePath: string): string {
  const preview = buffer.subarray(0, Math.min(buffer.length, 4096));
  if (preview.includes(0)) {
    throw new Error(`Cannot ingest binary file as markdown source: ${sourcePath}`);
  }
  return buffer.toString("utf8");
}

export async function ingestMemoryWikiSource(params: {
  config: ResolvedMemoryWikiConfig;
  inputPath: string;
  title?: string;
  nowMs?: number;
}): Promise<IngestMemoryWikiSourceResult> {
  await initializeMemoryWikiVault(params.config, { nowMs: params.nowMs });
  const sourcePath = path.resolve(params.inputPath);
  const buffer = await fs.readFile(sourcePath);
  const content = assertUtf8Text(buffer, sourcePath);
  const title = resolveSourceTitle(sourcePath, params.title);
  const slug = slugifyWikiSegment(title);
  const pageId = `source.${slug}`;
  const pageRelativePath = path.join("sources", `${slug}.md`);
  const pagePath = path.join(params.config.vault.path, pageRelativePath);
  const created = !(await pathExists(pagePath));
  const timestamp = new Date(params.nowMs ?? Date.now()).toISOString();

  const markdown = renderWikiMarkdown({
    body: [
      `# ${title}`,
      "",
      "## Source",
      `- Type: \`local-file\``,
      `- Path: \`${sourcePath}\``,
      `- Bytes: ${buffer.byteLength}`,
      `- Updated: ${timestamp}`,
      "",
      "## Content",
      renderMarkdownFence(content, "text"),
      "",
      "## Notes",
      "<!-- openclaw:human:start -->",
      "<!-- openclaw:human:end -->",
      "",
    ].join("\n"),
    frontmatter: {
      id: pageId,
      ingestedAt: timestamp,
      pageType: "source",
      sourcePath,
      sourceType: "local-file",
      status: "active",
      title,
      updatedAt: timestamp,
    },
  });

  await fs.writeFile(pagePath, markdown, "utf8");
  await appendMemoryWikiLog(params.config.vault.path, {
    details: {
      bytes: buffer.byteLength,
      created,
      inputPath: sourcePath,
      pageId,
      pagePath: pageRelativePath.split(path.sep).join("/"),
    },
    timestamp,
    type: "ingest",
  });
  const compile = await compileMemoryWikiVault(params.config);

  return {
    bytes: buffer.byteLength,
    created,
    indexUpdatedFiles: compile.updatedFiles,
    pageId,
    pagePath: pageRelativePath.split(path.sep).join("/"),
    sourcePath,
    title,
  };
}
