import type { ServerResponse } from "node:http";
import { vi } from "vitest";

export function makeMockHttpResponse(): {
  res: ServerResponse;
  setHeader: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
} {
  const setHeader = vi.fn();
  const end = vi.fn();
  const res = {
    end,
    headersSent: false,
    setHeader,
    statusCode: 200,
  } as unknown as ServerResponse;
  return { end, res, setHeader };
}
