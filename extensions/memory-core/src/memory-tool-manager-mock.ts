import { vi } from "vitest";

export type SearchImpl = () => Promise<unknown[]>;
export interface MemoryReadParams { relPath: string; from?: number; lines?: number }
export interface MemoryReadResult { text: string; path: string }
type MemoryBackend = "builtin" | "qmd";

let backend: MemoryBackend = "builtin";
let workspaceDir = "/workspace";
let searchImpl: SearchImpl = async () => [];
let readFileImpl: (params: MemoryReadParams) => Promise<MemoryReadResult> = async (params) => ({
  path: params.relPath,
  text: "",
});

const stubManager = {
  close: vi.fn(),
  probeVectorAvailability: vi.fn(async () => true),
  readFile: vi.fn(async (params: MemoryReadParams) => await readFileImpl(params)),
  search: vi.fn(async () => await searchImpl()),
  status: () => ({
    backend,
    chunks: 1,
    dbPath: "/workspace/.memory/index.sqlite",
    dirty: false,
    files: 1,
    model: "builtin",
    provider: "builtin",
    requestedProvider: "builtin",
    sourceCounts: [{ source: "memory" as const, files: 1, chunks: 1 }],
    sources: ["memory" as const],
    workspaceDir,
  }),
  sync: vi.fn(),
};

const getMemorySearchManagerMock = vi.fn(async () => ({ manager: stubManager }));
const readAgentMemoryFileMock = vi.fn(
  async (params: MemoryReadParams) => await readFileImpl(params),
);

vi.mock("./tools.runtime.js", () => ({
  getMemorySearchManager: getMemorySearchManagerMock,
  readAgentMemoryFile: readAgentMemoryFileMock,
  resolveMemoryBackendConfig: ({
    cfg,
  }: {
    cfg?: { memory?: { backend?: string; qmd?: unknown } };
  }) => ({
    backend,
    qmd: cfg?.memory?.qmd,
  }),
}));

export function setMemoryBackend(next: MemoryBackend): void {
  backend = next;
}

export function setMemoryWorkspaceDir(next: string): void {
  workspaceDir = next;
}

export function setMemorySearchImpl(next: SearchImpl): void {
  searchImpl = next;
}

export function setMemoryReadFileImpl(
  next: (params: MemoryReadParams) => Promise<MemoryReadResult>,
): void {
  readFileImpl = next;
}

export function resetMemoryToolMockState(overrides?: {
  backend?: MemoryBackend;
  searchImpl?: SearchImpl;
  readFileImpl?: (params: MemoryReadParams) => Promise<MemoryReadResult>;
}): void {
  backend = overrides?.backend ?? "builtin";
  workspaceDir = "/workspace";
  searchImpl = overrides?.searchImpl ?? (async () => []);
  readFileImpl =
    overrides?.readFileImpl ??
    (async (params: MemoryReadParams) => ({ path: params.relPath, text: "" }));
  vi.clearAllMocks();
}

export function getMemorySearchManagerMockCalls(): number {
  return getMemorySearchManagerMock.mock.calls.length;
}

export function getReadAgentMemoryFileMockCalls(): number {
  return readAgentMemoryFileMock.mock.calls.length;
}
