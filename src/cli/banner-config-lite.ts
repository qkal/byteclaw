import { createConfigIO } from '../config/config.js';
import type { TaglineMode } from './tagline.js';

export function parseTaglineMode(value: unknown): TaglineMode | undefined {
  if (value === 'random' || value === 'default' || value === 'off') {
    return value;
  }
  return undefined;
}

let cachedTaglineMode: TaglineMode | undefined | null = null;

export function readCliBannerTaglineMode(
  env: NodeJS.ProcessEnv = process.env,
): TaglineMode | undefined {
  // Return cached result to avoid repeated config loading attempts
  if (cachedTaglineMode !== null) {
    return cachedTaglineMode;
  }
  try {
    const configIO = createConfigIO({ env });
    const parsed = configIO.loadConfig() as {
      cli?: { banner?: { taglineMode?: unknown } };
    };
    cachedTaglineMode = parseTaglineMode(parsed.cli?.banner?.taglineMode);
    return cachedTaglineMode;
  } catch (error) {
    // Silently ignore config loading errors to prevent breaking basic CLI commands
    // This handles missing plugin-sdk modules and other config issues
    cachedTaglineMode = undefined;
    return undefined;
  }
}
