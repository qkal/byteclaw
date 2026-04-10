import { createConfigIO } from '../config/config.js';
import type { TaglineMode } from './tagline.js';

export function parseTaglineMode(value: unknown): TaglineMode | undefined {
  if (value === 'random' || value === 'default' || value === 'off') {
    return value;
  }
  return undefined;
}

export function readCliBannerTaglineMode(
  env: NodeJS.ProcessEnv = process.env,
): TaglineMode | undefined {
  try {
    const configIO = createConfigIO({ env });
    const parsed = configIO.loadConfig() as {
      cli?: { banner?: { taglineMode?: unknown } };
    };
    return parseTaglineMode(parsed.cli?.banner?.taglineMode);
  } catch (error) {
    // Silently ignore config loading errors to prevent breaking basic CLI commands
    // This handles missing plugin-sdk modules and other config issues
    return undefined;
  }
}
