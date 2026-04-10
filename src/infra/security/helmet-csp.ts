/**
 * Security Middleware - Helmet + CSP
 * Provides HTTP security headers and Content Security Policy
 */

export interface CspOptions {
  defaultSrc?: string[];
  scriptSrc?: string[];
  styleSrc?: string[];
  imgSrc?: string[];
  connectSrc?: string[];
  fontSrc?: string[];
  objectSrc?: string[];
  mediaSrc?: string[];
  frameSrc?: string[];
  frameAncestors?: string[];
  baseUri?: string[];
  formAction?: string[];
  reportUri?: string;
  reportOnly?: boolean;
}

export interface SecurityHeadersOptions {
  csp?: CspOptions;
  hsts?: {
    maxAge: number;
    includeSubDomains?: boolean;
    preload?: boolean;
  };
  xFrameOptions?: "DENY" | "SAMEORIGIN" | "ALLOW-FROM";
  xContentTypeOptions?: boolean;
  xXssProtection?: "1; mode=block" | "0";
  referrerPolicy?:
    | "no-referrer"
    | "no-referrer-when-downgrade"
    | "origin"
    | "origin-when-cross-origin"
    | "same-origin"
    | "strict-origin"
    | "strict-origin-when-cross-origin"
    | "unsafe-url";
  permissionsPolicy?: string[];
}

/**
 * Generate Content Security Policy header
 */
export function generateCspHeader(options: CspOptions = {}): string {
  const directives: string[] = [];

  const addDirective = (name: string, values?: string[]) => {
    if (values && values.length > 0) {
      directives.push(`${name} ${values.join(" ")}`);
    }
  };

  addDirective("default-src", options.defaultSrc || ["'self'"]);
  addDirective("script-src", options.scriptSrc || ["'self'", "'unsafe-inline'", "'unsafe-eval'"]);
  addDirective("style-src", options.styleSrc || ["'self'", "'unsafe-inline'"]);
  addDirective("img-src", options.imgSrc || ["'self'", "data:", "https:"]);
  addDirective("connect-src", options.connectSrc || ["'self'"]);
  addDirective("font-src", options.fontSrc || ["'self'", "data:"]);
  addDirective("object-src", options.objectSrc || ["'none'"]);
  addDirective("media-src", options.mediaSrc || ["'self'"]);
  addDirective("frame-src", options.frameSrc || ["'none'"]);
  addDirective("frame-ancestors", options.frameAncestors || ["'none'"]);
  addDirective("base-uri", options.baseUri || ["'self'"]);
  addDirective("form-action", options.formAction || ["'self'"]);

  if (options.reportUri) {
    directives.push(`report-uri ${options.reportUri}`);
  }

  return directives.join("; ");
}

/**
 * Generate security headers object
 */
export function generateSecurityHeaders(
  options: SecurityHeadersOptions = {},
): Record<string, string> {
  const headers: Record<string, string> = {};

  // Content Security Policy
  if (options.csp) {
    const headerName = options.csp.reportOnly
      ? "Content-Security-Policy-Report-Only"
      : "Content-Security-Policy";
    headers[headerName] = generateCspHeader(options.csp);
  }

  // HTTP Strict Transport Security
  if (options.hsts) {
    const hsts = `max-age=${options.hsts.maxAge}`;
    const subDomains = options.hsts.includeSubDomains ? "; includeSubDomains" : "";
    const preload = options.hsts.preload ? "; preload" : "";
    headers["Strict-Transport-Security"] = `${hsts}${subDomains}${preload}`;
  }

  // X-Frame-Options
  if (options.xFrameOptions) {
    headers["X-Frame-Options"] = options.xFrameOptions;
  }

  // X-Content-Type-Options
  if (options.xContentTypeOptions !== false) {
    headers["X-Content-Type-Options"] = "nosniff";
  }

  // X-XSS-Protection
  if (options.xXssProtection) {
    headers["X-XSS-Protection"] = options.xXssProtection;
  }

  // Referrer-Policy
  if (options.referrerPolicy) {
    headers["Referrer-Policy"] = options.referrerPolicy;
  }

  // Permissions-Policy
  if (options.permissionsPolicy && options.permissionsPolicy.length > 0) {
    headers["Permissions-Policy"] = options.permissionsPolicy.join(", ");
  }

  return headers;
}

/**
 * Apply security headers to a response (for Node.js HTTP server)
 */
export function applySecurityHeaders(
  response: { setHeader: (name: string, value: string) => void },
  options: SecurityHeadersOptions = {},
): void {
  const headers = generateSecurityHeaders(options);
  for (const [name, value] of Object.entries(headers)) {
    response.setHeader(name, value);
  }
}

/**
 * Default security headers configuration for OpenClaw
 */
export const defaultSecurityHeaders: SecurityHeadersOptions = {
  csp: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
    styleSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", "data:", "https:", "blob:"],
    connectSrc: ["'self'", "wss:", "ws:"],
    fontSrc: ["'self'", "data:"],
    objectSrc: ["'none'"],
    mediaSrc: ["'self'", "blob:"],
    frameSrc: ["'none'"],
    frameAncestors: ["'none'"],
    baseUri: ["'self'"],
    formAction: ["'self'"],
  },
  hsts: {
    maxAge: 31536000, // 1 year
    includeSubDomains: true,
    preload: true,
  },
  xFrameOptions: "DENY",
  xContentTypeOptions: true,
  xXssProtection: "1; mode=block",
  referrerPolicy: "strict-origin-when-cross-origin",
  permissionsPolicy: ["geolocation=()", "microphone=()", "camera=()", "payment=(self)"],
};

/**
 * Relaxed security headers for development
 */
export const devSecurityHeaders: SecurityHeadersOptions = {
  csp: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "http://localhost:*"],
    styleSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", "data:", "https:", "blob:", "http://localhost:*"],
    connectSrc: ["'self'", "wss:", "ws:", "http://localhost:*", "https://localhost:*"],
    fontSrc: ["'self'", "data:"],
    objectSrc: ["'none'"],
    mediaSrc: ["'self'", "blob:"],
    frameSrc: ["'self'"],
    frameAncestors: ["'self'"],
    baseUri: ["'self'"],
    formAction: ["'self'"],
  },
  hsts: {
    maxAge: 0, // Disabled in dev
    includeSubDomains: false,
    preload: false,
  },
  xFrameOptions: "SAMEORIGIN",
  xContentTypeOptions: true,
  xXssProtection: "1; mode=block",
  referrerPolicy: "no-referrer-when-downgrade",
  permissionsPolicy: [],
};
