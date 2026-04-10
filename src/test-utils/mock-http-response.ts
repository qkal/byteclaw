import type { ServerResponse } from "node:http";
import { lowercasePreservingWhitespace } from "../shared/string-coerce.js";

export function createMockServerResponse(): ServerResponse & { body?: string } {
  const headers: Record<string, string> = {};
  const res: {
    headersSent: boolean;
    statusCode: number;
    body?: string;
    setHeader: (key: string, value: string) => unknown;
    getHeader: (key: string) => string | undefined;
    end: (body?: string) => unknown;
  } = {
    end: (body?: string) => {
      res.headersSent = true;
      res.body = body;
      return res;
    },
    getHeader: (key: string) => headers[lowercasePreservingWhitespace(key)],
    headersSent: false,
    setHeader: (key: string, value: string) => {
      headers[lowercasePreservingWhitespace(key)] = value;
      return res;
    },
    statusCode: 200,
  };
  return res as unknown as ServerResponse & { body?: string };
}
