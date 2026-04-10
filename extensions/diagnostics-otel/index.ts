import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createDiagnosticsOtelService } from "./src/service.js";

export default definePluginEntry({
  description: "Export diagnostics events to OpenTelemetry",
  id: "diagnostics-otel",
  name: "Diagnostics OpenTelemetry",
  register(api) {
    api.registerService(createDiagnosticsOtelService());
  },
});
