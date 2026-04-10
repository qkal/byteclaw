import { describe, expect, it } from 'vitest';
import {
  type EnvSubstitutionWarning,
  MissingEnvVarError,
  containsEnvVarReference,
  resolveConfigEnvVars,
} from './env-substitution.js';

interface SubstitutionScenario {
  name: string;
  config: unknown;
  env: Record<string, string>;
  expected: unknown;
}

interface MissingEnvScenario {
  name: string;
  config: unknown;
  env: Record<string, string>;
  varName: string;
  configPath: string;
}

function expectResolvedScenarios(scenarios: SubstitutionScenario[]) {
  for (const scenario of scenarios) {
    const result = resolveConfigEnvVars(scenario.config, scenario.env);
    expect(result, scenario.name).toEqual(scenario.expected);
  }
}

function expectMissingScenarios(scenarios: MissingEnvScenario[]) {
  for (const scenario of scenarios) {
    try {
      resolveConfigEnvVars(scenario.config, scenario.env);
      expect.fail(`${scenario.name}: expected MissingEnvVarError`);
    } catch (error) {
      expect(error, scenario.name).toBeInstanceOf(MissingEnvVarError);
      const missingError = error as MissingEnvVarError;
      expect(missingError.varName, scenario.name).toBe(scenario.varName);
      expect(missingError.configPath, scenario.name).toBe(scenario.configPath);
    }
  }
}

describe('resolveConfigEnvVars', () => {
  describe('basic substitution', () => {
    it('substitutes direct, inline, repeated, and multi-var patterns', () => {
      const scenarios: SubstitutionScenario[] = [
        {
          config: { key: '${FOO}' },
          env: { FOO: 'bar' },
          expected: { key: 'bar' },
          name: 'single env var',
        },
        {
          config: { key: '${A}/${B}' },
          env: { A: 'x', B: 'y' },
          expected: { key: 'x/y' },
          name: 'multiple env vars in same string',
        },
        {
          config: { key: 'prefix-${FOO}-suffix' },
          env: { FOO: 'bar' },
          expected: { key: 'prefix-bar-suffix' },
          name: 'inline prefix/suffix',
        },
        {
          config: { key: '${FOO}:${FOO}' },
          env: { FOO: 'bar' },
          expected: { key: 'bar:bar' },
          name: 'same var repeated',
        },
      ];

      expectResolvedScenarios(scenarios);
    });
  });

  describe('nested structures', () => {
    it('substitutes variables in nested objects and arrays', () => {
      const scenarios: SubstitutionScenario[] = [
        {
          config: { outer: { inner: { key: '${API_KEY}' } } },
          env: { API_KEY: 'secret123' },
          expected: { outer: { inner: { key: 'secret123' } } },
          name: 'nested object',
        },
        {
          config: { items: ['${A}', '${B}', '${C}'] },
          env: { A: '1', B: '2', C: '3' },
          expected: { items: ['1', '2', '3'] },
          name: 'flat array',
        },
        {
          config: {
            providers: [
              { name: 'openai', apiKey: '${OPENAI_KEY}' },
              { name: 'anthropic', apiKey: '${ANTHROPIC_KEY}' },
            ],
          },
          env: { ANTHROPIC_KEY: 'sk-yyy', OPENAI_KEY: 'sk-xxx' },
          expected: {
            providers: [
              { name: 'openai', apiKey: 'sk-xxx' },
              { name: 'anthropic', apiKey: 'sk-yyy' },
            ],
          },
          name: 'array of objects',
        },
      ];

      expectResolvedScenarios(scenarios);
    });
  });

  describe('missing env var handling', () => {
    it('throws MissingEnvVarError with var name and config path details', () => {
      const scenarios: MissingEnvScenario[] = [
        {
          config: { key: '${MISSING}' },
          configPath: 'key',
          env: {},
          name: 'missing top-level var',
          varName: 'MISSING',
        },
        {
          config: { outer: { inner: { key: '${MISSING_VAR}' } } },
          configPath: 'outer.inner.key',
          env: {},
          name: 'missing nested var',
          varName: 'MISSING_VAR',
        },
        {
          config: { items: ['ok', '${MISSING}'] },
          configPath: 'items[1]',
          env: { OK: 'val' },
          name: 'missing var in array element',
          varName: 'MISSING',
        },
        {
          config: { key: '${EMPTY}' },
          configPath: 'key',
          env: { EMPTY: '' },
          name: 'empty string env value treated as missing',
          varName: 'EMPTY',
        },
      ];

      expectMissingScenarios(scenarios);
    });
  });

  describe('escape syntax', () => {
    it('handles escaped placeholders alongside regular substitutions', () => {
      const scenarios: SubstitutionScenario[] = [
        {
          config: { key: '$${VAR}' },
          env: { VAR: 'value' },
          expected: { key: '${VAR}' },
          name: 'escaped placeholder stays literal',
        },
        {
          config: { key: '${REAL}/$${LITERAL}' },
          env: { REAL: 'resolved' },
          expected: { key: 'resolved/${LITERAL}' },
          name: 'mix of escaped and unescaped vars',
        },
        {
          config: { key: '$${FOO} ${FOO}' },
          env: { FOO: 'bar' },
          expected: { key: '${FOO} bar' },
          name: 'escaped first, unescaped second',
        },
        {
          config: { key: '${FOO} $${FOO}' },
          env: { FOO: 'bar' },
          expected: { key: 'bar ${FOO}' },
          name: 'unescaped first, escaped second',
        },
        {
          config: { key: '$${A}:$${B}' },
          env: {},
          expected: { key: '${A}:${B}' },
          name: 'multiple escaped placeholders',
        },
        {
          config: { key: '${FOO}' },
          env: { FOO: '$${BAR}' },
          expected: { key: '$${BAR}' },
          name: 'env values are not unescaped',
        },
      ];

      expectResolvedScenarios(scenarios);
    });
  });

  describe('pattern matching rules', () => {
    it('leaves non-matching placeholders unchanged', () => {
      const scenarios: SubstitutionScenario[] = [
        {
          config: { key: '$VAR' },
          env: { VAR: 'value' },
          expected: { key: '$VAR' },
          name: '$VAR (no braces)',
        },
        {
          config: { key: '${lowercase}' },
          env: { lowercase: 'value' },
          expected: { key: '${lowercase}' },
          name: 'lowercase placeholder',
        },
        {
          config: { key: '${MixedCase}' },
          env: { MixedCase: 'value' },
          expected: { key: '${MixedCase}' },
          name: 'mixed-case placeholder',
        },
        {
          config: { key: '${123INVALID}' },
          env: {},
          expected: { key: '${123INVALID}' },
          name: 'invalid numeric prefix',
        },
      ];

      expectResolvedScenarios(scenarios);
    });

    it('substitutes valid uppercase/underscore placeholder names', () => {
      const scenarios: SubstitutionScenario[] = [
        {
          config: { key: '${_UNDERSCORE_START}' },
          env: { _UNDERSCORE_START: 'valid' },
          expected: { key: 'valid' },
          name: 'underscore-prefixed name',
        },
        {
          config: { key: '${VAR_WITH_NUMBERS_123}' },
          env: { VAR_WITH_NUMBERS_123: 'valid' },
          expected: { key: 'valid' },
          name: 'name with numbers',
        },
      ];

      expectResolvedScenarios(scenarios);
    });
  });

  describe('passthrough behavior', () => {
    it('passes through primitives unchanged', () => {
      for (const value of ['hello', 42, true, null]) {
        expect(resolveConfigEnvVars(value, {})).toBe(value);
      }
    });

    it('preserves empty and non-string containers', () => {
      const scenarios: { config: unknown; expected: unknown }[] = [
        { config: {}, expected: {} },
        { config: [], expected: [] },
        {
          config: { arr: [1, 2], bool: true, nil: null, num: 42 },
          expected: { arr: [1, 2], bool: true, nil: null, num: 42 },
        },
      ];

      for (const scenario of scenarios) {
        expect(resolveConfigEnvVars(scenario.config, {})).toEqual(
          scenario.expected,
        );
      }
    });
  });

  describe('graceful missing env var handling (onMissing)', () => {
    it('collects warnings and preserves placeholder when onMissing is set', () => {
      const warnings: EnvSubstitutionWarning[] = [];
      const result = resolveConfigEnvVars(
        { key: '${MISSING_VAR}', present: '${PRESENT}' },
        { PRESENT: 'ok' } as NodeJS.ProcessEnv,
        { onMissing: (w) => warnings.push(w) },
      );
      expect(result).toEqual({ key: '${MISSING_VAR}', present: 'ok' });
      expect(warnings).toEqual([{ configPath: 'key', varName: 'MISSING_VAR' }]);
    });

    it('collects multiple warnings across nested paths', () => {
      const warnings: EnvSubstitutionWarning[] = [];
      const result = resolveConfigEnvVars(
        {
          gateway: { token: '${GW_TOKEN}' },
          providers: {
            stt: { apiKey: '${STT_KEY}' },
            tts: { apiKey: '${TTS_KEY}' },
          },
        },
        { GW_TOKEN: 'secret' } as NodeJS.ProcessEnv,
        { onMissing: (w) => warnings.push(w) },
      );
      expect(result).toEqual({
        gateway: { token: 'secret' },
        providers: {
          stt: { apiKey: '${STT_KEY}' },
          tts: { apiKey: '${TTS_KEY}' },
        },
      });
      expect(warnings).toHaveLength(2);
      expect(warnings[0]).toEqual({
        configPath: 'providers.tts.apiKey',
        varName: 'TTS_KEY',
      });
      expect(warnings[1]).toEqual({
        configPath: 'providers.stt.apiKey',
        varName: 'STT_KEY',
      });
    });

    it('still throws when onMissing is not set', () => {
      expect(() =>
        resolveConfigEnvVars({ key: '${MISSING}' }, {} as NodeJS.ProcessEnv),
      ).toThrow(MissingEnvVarError);
    });
  });

  describe('containsEnvVarReference', () => {
    it('detects unresolved env var placeholders', () => {
      expect(containsEnvVarReference('${FOO}')).toBe(true);
      expect(containsEnvVarReference('prefix-${VAR}-suffix')).toBe(true);
      expect(containsEnvVarReference('${A}/${B}')).toBe(true);
      expect(containsEnvVarReference('${_UNDERSCORE}')).toBe(true);
      expect(containsEnvVarReference('${VAR_WITH_123}')).toBe(true);
    });

    it('returns false for non-matching patterns', () => {
      expect(containsEnvVarReference('no-refs-here')).toBe(false);
      expect(containsEnvVarReference('$VAR')).toBe(false);
      expect(containsEnvVarReference('${lowercase}')).toBe(false);
      expect(containsEnvVarReference('${MixedCase}')).toBe(false);
      expect(containsEnvVarReference('${123INVALID}')).toBe(false);
      expect(containsEnvVarReference('')).toBe(false);
    });

    it('returns false for escaped placeholders', () => {
      expect(containsEnvVarReference('$${ESCAPED}')).toBe(false);
      expect(containsEnvVarReference('prefix-$${ESCAPED}-suffix')).toBe(false);
    });

    it('detects references mixed with escaped placeholders', () => {
      expect(containsEnvVarReference('$${ESCAPED} ${REAL}')).toBe(true);
      expect(containsEnvVarReference('${REAL} $${ESCAPED}')).toBe(true);
    });
  });

  describe('real-world config patterns', () => {
    it('substitutes provider, gateway, and base URL config values', () => {
      const scenarios: SubstitutionScenario[] = [
        {
          config: {
            models: {
              providers: {
                openai: { apiKey: '${OPENAI_API_KEY}' },
                'vercel-gateway': { apiKey: '${VERCEL_GATEWAY_API_KEY}' },
              },
            },
          },
          env: {
            OPENAI_API_KEY: 'sk-xxx',
            VERCEL_GATEWAY_API_KEY: 'vg_key_123',
          },
          expected: {
            models: {
              providers: {
                openai: { apiKey: 'sk-xxx' },
                'vercel-gateway': { apiKey: 'vg_key_123' },
              },
            },
          },
          name: 'provider API keys',
        },
        {
          config: { gateway: { auth: { token: '${OPENCLAW_GATEWAY_TOKEN}' } } },
          env: { OPENCLAW_GATEWAY_TOKEN: 'secret-token' },
          expected: { gateway: { auth: { token: 'secret-token' } } },
          name: 'gateway auth token',
        },
        {
          config: {
            models: {
              providers: {
                custom: { baseUrl: '${CUSTOM_API_BASE}/v1' },
              },
            },
          },
          env: { CUSTOM_API_BASE: 'https://api.example.com' },
          expected: {
            models: {
              providers: {
                custom: { baseUrl: 'https://api.example.com/v1' },
              },
            },
          },
          name: 'provider base URL composition',
        },
      ];

      expectResolvedScenarios(scenarios);
    });
  });
});
