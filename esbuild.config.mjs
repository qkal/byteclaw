import * as esbuild from "esbuild";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const isProduction = process.env.NODE_ENV === "production";
const isWatch = process.argv.includes("--watch");

// Common esbuild options
const baseOptions = {
  bundle: true,
  minify: isProduction,
  sourcemap: !isProduction,
  target: "node22",
  platform: "node",
  format: "esm",
  logLevel: "info",
  treeShaking: true,
  metafile: isProduction,
  define: {
    "process.env.NODE_ENV": JSON.stringify(isProduction ? "production" : "development"),
  },
};

// External dependencies for bundled builds
const externalDeps = [
  // Keep these as external for Node.js
  "node:*",
  // Keep heavy dependencies external unless needed
  "@aws-sdk/*",
  "@anthropic-ai/*",
  "@google/genai",
  "openai",
  "sharp",
  "pdfjs-dist",
  "playwright-core",
  // Optional peer dependencies
  "@napi-rs/canvas",
  "node-llama-cpp",
];

// Build CLI entry point (bundled for fast startup)
async function buildCliEntry() {
  console.log("Building CLI entry point...");

  const ctx = await esbuild.context({
    ...baseOptions,
    entryPoints: [join(__dirname, "src/entry.ts")],
    outfile: join(__dirname, "openclaw.mjs"),
    banner: {
      js: "#!/usr/bin/env node",
    },
    // More aggressive bundling for CLI entry
    external: [
      ...externalDeps,
      // Keep channel plugins external (loaded dynamically)
      "openclaw/extension-api",
      "@openclaw/*",
    ],
  });

  if (isWatch) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }

  console.log("CLI entry point built: openclaw.mjs");
}

// Build library exports (non-bundled, for library usage)
async function buildLibrary() {
  console.log("Building library exports...");

  const ctx = await esbuild.context({
    ...baseOptions,
    entryPoints: [join(__dirname, "src/index.ts")],
    outfile: join(__dirname, "dist/index.js"),
    bundle: false,
    treeShaking: false,
  });

  if (isWatch) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }

  console.log("Library built: dist/index.js");
}

// Build plugin SDK
async function buildPluginSdk() {
  console.log("Building plugin SDK...");

  mkdirSync(join(__dirname, "dist/plugin-sdk"), { recursive: true });

  const ctx = await esbuild.context({
    ...baseOptions,
    entryPoints: [
      join(__dirname, "src/plugin-sdk/index.ts"),
      join(__dirname, "src/plugin-sdk/core.ts"),
    ],
    outdir: join(__dirname, "dist/plugin-sdk"),
    bundle: false,
    treeShaking: false,
  });

  if (isWatch) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }

  console.log("Plugin SDK built: dist/plugin-sdk/");
}

// Main build function
async function build() {
  const start = Date.now();

  try {
    // Clean dist directory if not incremental
    if (!isWatch) {
      rmSync(join(__dirname, "dist"), { recursive: true, force: true });
      rmSync(join(__dirname, "openclaw.mjs"), { force: true });
    }

    // Build all targets
    await Promise.all([buildCliEntry(), buildLibrary(), buildPluginSdk()]);

    const duration = Date.now() - start;
    console.log(`✓ Build completed in ${duration}ms`);

    if (isProduction && baseOptions.metafile) {
      console.log("Metafile generated for bundle analysis");
    }
  } catch (error) {
    console.error("Build failed:", error);
    process.exit(1);
  }
}

// Run build
build();
