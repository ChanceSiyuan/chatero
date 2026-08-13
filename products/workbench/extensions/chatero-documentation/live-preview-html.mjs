const NONCE_PATTERN = /^[A-Za-z0-9_-]{24}$/;

function attribute(value, label) {
  const text = String(value);
  if (!text || /[\u0000-\u001F\u007F]/u.test(text)) throw new TypeError(`${label} is invalid`);
  return text.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function trustedResource(value, cspSource, label) {
  const resource = String(value);
  let underCspSource = resource.startsWith(cspSource);
  const wildcard = cspSource.match(/^https:\/\/\*\.([A-Za-z0-9.-]+)$/u);
  if (wildcard) {
    try {
      const parsed = new URL(resource);
      underCspSource = parsed.protocol === "https:"
        && parsed.hostname.endsWith(`.${wildcard[1]}`)
        && parsed.hostname.length > wildcard[1].length + 1;
    }
    catch {
      underCspSource = false;
    }
  }
  if (!underCspSource || /[\s"'<>]/u.test(resource)) {
    throw new TypeError(`${label} is outside the materialized webview resource authority`);
  }
  return attribute(resource, label);
}

function trustedCspSource(value) {
  const fixedScheme = typeof value === "string"
    && /^[A-Za-z][A-Za-z0-9+.-]*:[^\s;'"<>*]*$/u.test(value);
  const vscodeCdnWildcard = typeof value === "string"
    && /^https:\/\/\*\.[A-Za-z0-9.-]+$/u.test(value);
  // Code-OSS 1.132 exposes `'self' https://*.vscode-cdn.net` as a
  // space-separated source list. Accept that exact leading `'self'` form and
  // keep only the webview resource wildcard for URI validation and the CSP.
  const selfPrefixedWildcard = typeof value === "string"
    && value.startsWith("'self' ")
    && /^https:\/\/\*\.[A-Za-z0-9.-]+$/u.test(value.slice("'self' ".length));
  if ((!fixedScheme && !vscodeCdnWildcard && !selfPrefixedWildcard)
    || /^(?:data|blob|file|javascript):/iu.test(value)) {
    throw new TypeError("webview.cspSource is invalid");
  }
  return selfPrefixedWildcard ? value.slice("'self' ".length) : value;
}

export function createLivePreviewHtml({ webview, scriptUri, styleUri, nonce }) {
  if (!webview || typeof webview.cspSource !== "string") throw new TypeError("webview.cspSource is required");
  if (typeof nonce !== "string" || !NONCE_PATTERN.test(nonce)) {
    throw new TypeError("Live Preview nonce must be exactly 24 base64url characters");
  }
  const cspSource = trustedCspSource(webview.cspSource);
  const script = trustedResource(scriptUri, cspSource, "Live Preview script URI");
  const style = trustedResource(styleUri, cspSource, "Live Preview stylesheet URI");
  const csp = `default-src 'none'; script-src 'nonce-${nonce}'; style-src ${cspSource} 'nonce-${nonce}'; font-src ${cspSource}; img-src ${cspSource};`;
  return [
    "<!DOCTYPE html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="UTF-8">',
    `<meta http-equiv="Content-Security-Policy" content="${csp}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
    '<title>Chatero Live Preview</title>',
    `<link rel="stylesheet" href="${style}">`,
    "</head>",
    "<body>",
    '<main data-documentation-editor aria-label="Documentation source editor"></main>',
    `<script nonce="${nonce}" src="${script}"></script>`,
    "</body>",
    "</html>",
  ].join("\n");
}
