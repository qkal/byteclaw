import { describe, expect, it } from "vitest";
import { classifyControlUiRequest } from "./control-ui-routing.js";

describe("classifyControlUiRequest", () => {
  describe("root-mounted control ui", () => {
    it.each([
      {
        expected: { kind: "serve" as const },
        method: "GET",
        name: "serves the root entrypoint",
        pathname: "/",
      },
      {
        expected: { kind: "serve" as const },
        method: "HEAD",
        name: "serves other read-only SPA routes",
        pathname: "/chat",
      },
      {
        expected: { kind: "not-control-ui" as const },
        method: "GET",
        name: "keeps health probes outside the SPA catch-all",
        pathname: "/healthz",
      },
      {
        expected: { kind: "not-control-ui" as const },
        method: "HEAD",
        name: "keeps readiness probes outside the SPA catch-all",
        pathname: "/ready",
      },
      {
        expected: { kind: "not-control-ui" as const },
        method: "GET",
        name: "keeps plugin routes outside the SPA catch-all",
        pathname: "/plugins/webhook",
      },
      {
        expected: { kind: "not-control-ui" as const },
        method: "GET",
        name: "keeps API routes outside the SPA catch-all",
        pathname: "/api/sessions",
      },
      {
        expected: { kind: "not-found" as const },
        method: "GET",
        name: "returns not-found for legacy ui routes",
        pathname: "/ui/settings",
      },
      {
        expected: { kind: "not-control-ui" as const },
        method: "POST",
        name: "falls through non-read requests",
        pathname: "/bluebubbles-webhook",
      },
    ])("$name", ({ pathname, method, expected }) => {
      expect(
        classifyControlUiRequest({
          basePath: "",
          method,
          pathname,
          search: "",
        }),
      ).toEqual(expected);
    });
  });

  describe("basePath-mounted control ui", () => {
    it.each([
      {
        expected: { kind: "redirect" as const, location: "/openclaw/?foo=1" },
        method: "GET",
        name: "redirects the basePath entrypoint",
        pathname: "/openclaw",
        search: "?foo=1",
      },
      {
        expected: { kind: "serve" as const },
        method: "HEAD",
        name: "serves nested read-only routes",
        pathname: "/openclaw/chat",
        search: "",
      },
      {
        expected: { kind: "not-control-ui" as const },
        method: "GET",
        name: "falls through unmatched paths",
        pathname: "/elsewhere/chat",
        search: "",
      },
      {
        expected: { kind: "not-control-ui" as const },
        method: "POST",
        name: "falls through write requests to the basePath entrypoint",
        pathname: "/openclaw",
        search: "",
      },
      ...["PUT", "DELETE", "PATCH", "OPTIONS"].map((method) => ({
        expected: { kind: "not-control-ui" as const },
        method,
        name: `falls through ${method} subroute requests`,
        pathname: "/openclaw/webhook",
        search: "",
      })),
    ])("$name", ({ pathname, search, method, expected }) => {
      expect(
        classifyControlUiRequest({
          basePath: "/openclaw",
          method,
          pathname,
          search,
        }),
      ).toEqual(expected);
    });
  });
});
