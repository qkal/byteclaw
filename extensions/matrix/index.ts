import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { registerMatrixCliMetadata } from "./cli-metadata.js";

export default defineBundledChannelEntry({
  description: "Matrix channel plugin (matrix-js-sdk)",
  id: "matrix",
  importMetaUrl: import.meta.url,
  name: "Matrix",
  plugin: {
    exportName: "matrixPlugin",
    specifier: "./channel-plugin-api.js",
  },
  registerCliMetadata: registerMatrixCliMetadata,
  registerFull(api) {
    void import("./plugin-entry.handlers.runtime.js")
      .then(({ ensureMatrixCryptoRuntime }) =>
        ensureMatrixCryptoRuntime({ log: api.logger.info }).catch((error: unknown) => {
          const message = formatErrorMessage(error);
          api.logger.warn?.(`matrix: crypto runtime bootstrap failed: ${message}`);
        }),
      )
      .catch((error: unknown) => {
        const message = formatErrorMessage(error);
        api.logger.warn?.(`matrix: failed loading crypto bootstrap runtime: ${message}`);
      });

    api.registerGatewayMethod("matrix.verify.recoveryKey", async (ctx) => {
      const { handleVerifyRecoveryKey } = await import("./plugin-entry.handlers.runtime.js");
      await handleVerifyRecoveryKey(ctx);
    });

    api.registerGatewayMethod("matrix.verify.bootstrap", async (ctx) => {
      const { handleVerificationBootstrap } = await import("./plugin-entry.handlers.runtime.js");
      await handleVerificationBootstrap(ctx);
    });

    api.registerGatewayMethod("matrix.verify.status", async (ctx) => {
      const { handleVerificationStatus } = await import("./plugin-entry.handlers.runtime.js");
      await handleVerificationStatus(ctx);
    });
  },
  runtime: {
    exportName: "setMatrixRuntime",
    specifier: "./runtime-api.js",
  },
  secrets: {
    exportName: "channelSecrets",
    specifier: "./secret-contract-api.js",
  },
});
