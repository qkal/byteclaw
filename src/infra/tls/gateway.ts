import { execFile } from "node:child_process";
import { X509Certificate } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type tls from "node:tls";
import { promisify } from "node:util";
import type { GatewayTlsConfig } from "../../config/types.gateway.js";
import { CONFIG_DIR, ensureDir, resolveUserPath, shortenHomeInString } from "../../utils.js";
import { resolveSystemBin } from "../resolve-system-bin.js";
import { normalizeFingerprint } from "./fingerprint.js";

const execFileAsync = promisify(execFile);

export interface GatewayTlsRuntime {
  enabled: boolean;
  required: boolean;
  certPath?: string;
  keyPath?: string;
  caPath?: string;
  fingerprintSha256?: string;
  tlsOptions?: tls.TlsOptions;
  error?: string;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function generateSelfSignedCert(params: {
  certPath: string;
  keyPath: string;
  log?: { info?: (msg: string) => void };
}): Promise<void> {
  const certDir = path.dirname(params.certPath);
  const keyDir = path.dirname(params.keyPath);
  await ensureDir(certDir);
  if (keyDir !== certDir) {
    await ensureDir(keyDir);
  }
  const opensslBin = resolveSystemBin("openssl");
  if (!opensslBin) {
    throw new Error(
      "openssl not found in trusted system directories. Install it in an OS-managed location.",
    );
  }
  await execFileAsync(opensslBin, [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-sha256",
    "-days",
    "3650",
    "-nodes",
    "-keyout",
    params.keyPath,
    "-out",
    params.certPath,
    "-subj",
    "/CN=openclaw-gateway",
  ]);
  await fs.chmod(params.keyPath, 0o600).catch(() => {});
  await fs.chmod(params.certPath, 0o600).catch(() => {});
  params.log?.info?.(
    `gateway tls: generated self-signed cert at ${shortenHomeInString(params.certPath)}`,
  );
}

export async function loadGatewayTlsRuntime(
  cfg: GatewayTlsConfig | undefined,
  log?: { info?: (msg: string) => void; warn?: (msg: string) => void },
): Promise<GatewayTlsRuntime> {
  if (!cfg || cfg.enabled !== true) {
    return { enabled: false, required: false };
  }

  const autoGenerate = cfg.autoGenerate !== false;
  const baseDir = path.join(CONFIG_DIR, "gateway", "tls");
  const certPath = resolveUserPath(cfg.certPath ?? path.join(baseDir, "gateway-cert.pem"));
  const keyPath = resolveUserPath(cfg.keyPath ?? path.join(baseDir, "gateway-key.pem"));
  const caPath = cfg.caPath ? resolveUserPath(cfg.caPath) : undefined;

  const hasCert = await fileExists(certPath);
  const hasKey = await fileExists(keyPath);

  if (!hasCert && !hasKey && autoGenerate) {
    try {
      await generateSelfSignedCert({ certPath, keyPath, log });
    } catch (error) {
      return {
        certPath,
        enabled: false,
        error: `gateway tls: failed to generate cert (${String(error)})`,
        keyPath,
        required: true,
      };
    }
  }

  if (!(await fileExists(certPath)) || !(await fileExists(keyPath))) {
    return {
      certPath,
      enabled: false,
      error: "gateway tls: cert/key missing",
      keyPath,
      required: true,
    };
  }

  try {
    const cert = await fs.readFile(certPath, "utf8");
    const key = await fs.readFile(keyPath, "utf8");
    const ca = caPath ? await fs.readFile(caPath, "utf8") : undefined;
    const x509 = new X509Certificate(cert);
    const fingerprintSha256 = normalizeFingerprint(x509.fingerprint256 ?? "");

    if (!fingerprintSha256) {
      return {
        caPath,
        certPath,
        enabled: false,
        error: "gateway tls: unable to compute certificate fingerprint",
        keyPath,
        required: true,
      };
    }

    return {
      caPath,
      certPath,
      enabled: true,
      fingerprintSha256,
      keyPath,
      required: true,
      tlsOptions: {
        ca,
        cert,
        key,
        minVersion: "TLSv1.3",
      },
    };
  } catch (error) {
    return {
      caPath,
      certPath,
      enabled: false,
      error: `gateway tls: failed to load cert (${String(error)})`,
      keyPath,
      required: true,
    };
  }
}
