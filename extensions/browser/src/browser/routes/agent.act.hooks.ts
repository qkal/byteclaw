import { evaluateChromeMcpScript, uploadChromeMcpFile } from "../chrome-mcp.js";
import { getBrowserProfileCapabilities } from "../profile-capabilities.js";
import type { BrowserRouteContext } from "../server-context.js";
import {
  readBody,
  requirePwAi,
  resolveTargetIdFromBody,
  withRouteTabContext,
} from "./agent.shared.js";
import { EXISTING_SESSION_LIMITS } from "./existing-session-limits.js";
import { DEFAULT_UPLOAD_DIR, resolveExistingPathsWithinRoot } from "./path-output.js";
import type { BrowserRouteRegistrar } from "./types.js";
import { jsonError, toBoolean, toNumber, toStringArray, toStringOrEmpty } from "./utils.js";

export function registerBrowserAgentActHookRoutes(
  app: BrowserRouteRegistrar,
  ctx: BrowserRouteContext,
) {
  app.post("/hooks/file-chooser", async (req, res) => {
    const body = readBody(req);
    const targetId = resolveTargetIdFromBody(body);
    const ref = toStringOrEmpty(body.ref) || undefined;
    const inputRef = toStringOrEmpty(body.inputRef) || undefined;
    const element = toStringOrEmpty(body.element) || undefined;
    const paths = toStringArray(body.paths) ?? [];
    const timeoutMs = toNumber(body.timeoutMs);
    if (!paths.length) {
      return jsonError(res, 400, "paths are required");
    }

    await withRouteTabContext({
      ctx,
      req,
      res,
      run: async ({ profileCtx, cdpUrl, tab }) => {
        const uploadPathsResult = await resolveExistingPathsWithinRoot({
          requestedPaths: paths,
          rootDir: DEFAULT_UPLOAD_DIR,
          scopeLabel: `uploads directory (${DEFAULT_UPLOAD_DIR})`,
        });
        if (!uploadPathsResult.ok) {
          res.status(400).json({ error: uploadPathsResult.error });
          return;
        }
        const resolvedPaths = uploadPathsResult.paths;

        if (getBrowserProfileCapabilities(profileCtx.profile).usesChromeMcp) {
          if (element) {
            return jsonError(res, 501, EXISTING_SESSION_LIMITS.hooks.uploadElement);
          }
          if (resolvedPaths.length !== 1) {
            return jsonError(res, 501, EXISTING_SESSION_LIMITS.hooks.uploadSingleFile);
          }
          const uid = inputRef || ref;
          if (!uid) {
            return jsonError(res, 501, EXISTING_SESSION_LIMITS.hooks.uploadRefRequired);
          }
          await uploadChromeMcpFile({
            filePath: resolvedPaths[0] ?? "",
            profileName: profileCtx.profile.name,
            targetId: tab.targetId,
            uid,
            userDataDir: profileCtx.profile.userDataDir,
          });
          return res.json({ ok: true });
        }

        const pw = await requirePwAi(res, "file chooser hook");
        if (!pw) {
          return;
        }

        if (inputRef || element) {
          if (ref) {
            return jsonError(res, 400, "ref cannot be combined with inputRef/element");
          }
          await pw.setInputFilesViaPlaywright({
            cdpUrl,
            element,
            inputRef,
            paths: resolvedPaths,
            targetId: tab.targetId,
          });
        } else {
          await pw.armFileUploadViaPlaywright({
            cdpUrl,
            paths: resolvedPaths,
            targetId: tab.targetId,
            timeoutMs: timeoutMs ?? undefined,
          });
          if (ref) {
            await pw.clickViaPlaywright({
              cdpUrl,
              ref,
              ssrfPolicy: ctx.state().resolved.ssrfPolicy,
              targetId: tab.targetId,
            });
          }
        }
        res.json({ ok: true });
      },
      targetId,
    });
  });

  app.post("/hooks/dialog", async (req, res) => {
    const body = readBody(req);
    const targetId = resolveTargetIdFromBody(body);
    const accept = toBoolean(body.accept);
    const promptText = toStringOrEmpty(body.promptText) || undefined;
    const timeoutMs = toNumber(body.timeoutMs);
    if (accept === undefined) {
      return jsonError(res, 400, "accept is required");
    }

    await withRouteTabContext({
      ctx,
      req,
      res,
      run: async ({ profileCtx, cdpUrl, tab }) => {
        if (getBrowserProfileCapabilities(profileCtx.profile).usesChromeMcp) {
          if (timeoutMs) {
            return jsonError(res, 501, EXISTING_SESSION_LIMITS.hooks.dialogTimeout);
          }
          await evaluateChromeMcpScript({
            fn: `() => {
              const state = (window.__openclawDialogHook ??= {});
              if (!state.originals) {
                state.originals = {
                  alert: window.alert.bind(window),
                  confirm: window.confirm.bind(window),
                  prompt: window.prompt.bind(window),
                };
              }
              const originals = state.originals;
              const restore = () => {
                window.alert = originals.alert;
                window.confirm = originals.confirm;
                window.prompt = originals.prompt;
                delete window.__openclawDialogHook;
              };
              window.alert = (...args) => {
                try {
                  return undefined;
                } finally {
                  restore();
                }
              };
              window.confirm = (...args) => {
                try {
                  return ${accept ? "true" : "false"};
                } finally {
                  restore();
                }
              };
              window.prompt = (...args) => {
                try {
                  return ${accept ? JSON.stringify(promptText ?? "") : "null"};
                } finally {
                  restore();
                }
              };
              return true;
            }`,
            profileName: profileCtx.profile.name,
            targetId: tab.targetId,
            userDataDir: profileCtx.profile.userDataDir,
          });
          return res.json({ ok: true });
        }
        const pw = await requirePwAi(res, "dialog hook");
        if (!pw) {
          return;
        }
        await pw.armDialogViaPlaywright({
          accept,
          cdpUrl,
          promptText,
          targetId: tab.targetId,
          timeoutMs: timeoutMs ?? undefined,
        });
        res.json({ ok: true });
      },
      targetId,
    });
  });
}
