import type { Command } from "commander";
import { defaultRuntime } from "../../runtime.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";
import { getTerminalTableWidth, renderTable } from "../../terminal/table.js";
import { shortenHomePath } from "../../utils.js";
import {
  type CameraFacing,
  cameraTempPath,
  parseCameraClipPayload,
  parseCameraSnapPayload,
  writeCameraClipPayloadToFile,
  writeCameraPayloadToFile,
} from "../nodes-camera.js";
import { parseDurationMs } from "../parse-duration.js";
import { getNodesTheme, runNodesCommand } from "./cli-utils.js";
import {
  buildNodeInvokeParams,
  callGatewayCli,
  nodesCallOpts,
  resolveNode,
  resolveNodeId,
} from "./rpc.js";
import type { NodesRpcOpts } from "./types.js";

const parseFacing = (value: string): CameraFacing => {
  const v = normalizeLowercaseStringOrEmpty(normalizeOptionalString(value) ?? "");
  if (v === "front" || v === "back") {
    return v;
  }
  throw new Error(`invalid facing: ${value} (expected front|back)`);
};

function getGatewayInvokePayload(raw: unknown): unknown {
  return typeof raw === "object" && raw !== null
    ? (raw as { payload?: unknown }).payload
    : undefined;
}

export function registerNodesCameraCommands(nodes: Command) {
  const camera = nodes.command("camera").description("Capture camera media from a paired node");

  nodesCallOpts(
    camera
      .command("list")
      .description("List available cameras on a node")
      .requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP")
      .action(async (opts: NodesRpcOpts) => {
        await runNodesCommand("camera list", async () => {
          const nodeId = await resolveNodeId(opts, String(opts.node ?? ""));
          const raw = await callGatewayCli(
            "node.invoke",
            opts,
            buildNodeInvokeParams({
              command: "camera.list",
              nodeId,
              params: {},
            }),
          );

          const res = typeof raw === "object" && raw !== null ? (raw as { payload?: unknown }) : {};
          const payload =
            typeof res.payload === "object" && res.payload !== null
              ? (res.payload as { devices?: unknown })
              : {};
          const devices = Array.isArray(payload.devices) ? payload.devices : [];

          if (opts.json) {
            defaultRuntime.writeJson(devices);
            return;
          }

          if (devices.length === 0) {
            const { muted } = getNodesTheme();
            defaultRuntime.log(muted("No cameras reported."));
            return;
          }

          const { heading, muted } = getNodesTheme();
          const tableWidth = getTerminalTableWidth();
          const rows = devices.map((device) => ({
            ID: typeof device.id === "string" ? device.id : "",
            Name: typeof device.name === "string" ? device.name : "Unknown Camera",
            Position: typeof device.position === "string" ? device.position : muted("unspecified"),
          }));
          defaultRuntime.log(heading("Cameras"));
          defaultRuntime.log(
            renderTable({
              columns: [
                { flex: true, header: "Name", key: "Name", minWidth: 14 },
                { header: "Position", key: "Position", minWidth: 10 },
                { flex: true, header: "ID", key: "ID", minWidth: 10 },
              ],
              rows,
              width: tableWidth,
            }).trimEnd(),
          );
        });
      }),
    { timeoutMs: 60_000 },
  );

  nodesCallOpts(
    camera
      .command("snap")
      .description("Capture a photo from a node camera (prints MEDIA:<path>)")
      .requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP")
      .option("--facing <front|back|both>", "Camera facing", "both")
      .option("--device-id <id>", "Camera device id (from nodes camera list)")
      .option("--max-width <px>", "Max width in px (optional)")
      .option("--quality <0-1>", "JPEG quality (default 0.9)")
      .option("--delay-ms <ms>", "Delay before capture in ms (macOS default 2000)")
      .option("--invoke-timeout <ms>", "Node invoke timeout in ms (default 20000)", "20000")
      .action(async (opts: NodesRpcOpts) => {
        await runNodesCommand("camera snap", async () => {
          const node = await resolveNode(opts, normalizeOptionalString(opts.node) ?? "");
          const { nodeId } = node;
          const facingOpt = normalizeLowercaseStringOrEmpty(
            normalizeOptionalString(opts.facing) ?? "both",
          );
          const facings: CameraFacing[] =
            facingOpt === "both"
              ? ["front", "back"]
              : facingOpt === "front" || facingOpt === "back"
                ? [facingOpt]
                : (() => {
                    throw new Error(
                      `invalid facing: ${String(opts.facing)} (expected front|back|both)`,
                    );
                  })();

          const maxWidth = opts.maxWidth ? Number.parseInt(String(opts.maxWidth), 10) : undefined;
          const quality = opts.quality ? Number.parseFloat(String(opts.quality)) : undefined;
          const delayMs = opts.delayMs ? Number.parseInt(String(opts.delayMs), 10) : undefined;
          const deviceId = normalizeOptionalString(opts.deviceId);
          if (deviceId && facings.length > 1) {
            throw new Error("facing=both is not allowed when --device-id is set");
          }
          const timeoutMs = opts.invokeTimeout
            ? Number.parseInt(String(opts.invokeTimeout), 10)
            : undefined;

          const results: {
            facing: CameraFacing;
            path: string;
            width: number;
            height: number;
          }[] = [];

          for (const facing of facings) {
            const invokeParams = buildNodeInvokeParams({
              command: "camera.snap",
              nodeId,
              params: {
                delayMs: Number.isFinite(delayMs) ? delayMs : undefined,
                deviceId: deviceId || undefined,
                facing,
                format: "jpg",
                maxWidth: Number.isFinite(maxWidth) ? maxWidth : undefined,
                quality: Number.isFinite(quality) ? quality : undefined,
              },
              timeoutMs,
            });

            const raw = await callGatewayCli("node.invoke", opts, invokeParams);
            const payload = parseCameraSnapPayload(getGatewayInvokePayload(raw));
            const filePath = cameraTempPath({
              ext: payload.format === "jpeg" ? "jpg" : payload.format,
              facing,
              kind: "snap",
            });
            await writeCameraPayloadToFile({
              expectedHost: node.remoteIp,
              filePath,
              invalidPayloadMessage: "invalid camera.snap payload",
              payload,
            });
            results.push({
              facing,
              height: payload.height,
              path: filePath,
              width: payload.width,
            });
          }

          if (opts.json) {
            defaultRuntime.writeJson({ files: results });
            return;
          }
          defaultRuntime.log(results.map((r) => `MEDIA:${shortenHomePath(r.path)}`).join("\n"));
        });
      }),
    { timeoutMs: 60_000 },
  );

  nodesCallOpts(
    camera
      .command("clip")
      .description("Capture a short video clip from a node camera (prints MEDIA:<path>)")
      .requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP")
      .option("--facing <front|back>", "Camera facing", "front")
      .option("--device-id <id>", "Camera device id (from nodes camera list)")
      .option(
        "--duration <ms|10s|1m>",
        "Duration (default 3000ms; supports ms/s/m, e.g. 10s)",
        "3000",
      )
      .option("--no-audio", "Disable audio capture")
      .option("--invoke-timeout <ms>", "Node invoke timeout in ms (default 90000)", "90000")
      .action(async (opts: NodesRpcOpts & { audio?: boolean }) => {
        await runNodesCommand("camera clip", async () => {
          const node = await resolveNode(opts, normalizeOptionalString(opts.node) ?? "");
          const { nodeId } = node;
          const facing = parseFacing(String(opts.facing ?? "front"));
          const durationMs = parseDurationMs(String(opts.duration ?? "3000"));
          const includeAudio = opts.audio !== false;
          const timeoutMs = opts.invokeTimeout
            ? Number.parseInt(String(opts.invokeTimeout), 10)
            : undefined;
          const deviceId = normalizeOptionalString(opts.deviceId);

          const invokeParams = buildNodeInvokeParams({
            command: "camera.clip",
            nodeId,
            params: {
              deviceId: deviceId || undefined,
              durationMs: Number.isFinite(durationMs) ? durationMs : undefined,
              facing,
              format: "mp4",
              includeAudio,
            },
            timeoutMs,
          });

          const raw = await callGatewayCli("node.invoke", opts, invokeParams);
          const payload = parseCameraClipPayload(getGatewayInvokePayload(raw));
          const filePath = await writeCameraClipPayloadToFile({
            expectedHost: node.remoteIp,
            facing,
            payload,
          });

          if (opts.json) {
            defaultRuntime.writeJson({
              file: {
                durationMs: payload.durationMs,
                facing,
                hasAudio: payload.hasAudio,
                path: filePath,
              },
            });
            return;
          }
          defaultRuntime.log(`MEDIA:${shortenHomePath(filePath)}`);
        });
      }),
    { timeoutMs: 90_000 },
  );
}
