const NONCE_PATTERN = /^[A-Za-z0-9_-]{24}$/;

function attribute(value, label) {
  const text = String(value);
  if (!text || /[\u0000-\u001F\u007F]/u.test(text)) throw new TypeError(`${label} is invalid`);
  return text.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function trustedResource(value, cspSource, label) {
  const resource = String(value);
  if (!resource.startsWith(cspSource) || /[\s"'<>]/u.test(resource)) {
    throw new TypeError(`${label} is outside the materialized webview resource authority`);
  }
  return attribute(resource, label);
}

function trustedCspSource(value) {
  if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9+.-]*:[^\s;'"<>]*$/u.test(value)
    || /^(?:data|blob|file|javascript):/iu.test(value) || value.includes("*")) {
    throw new TypeError("webview.cspSource is invalid");
  }
  return value;
}

export function createLivePreviewHtml({ webview, scriptUri, styleUri, nonce }) {
  if (!webview || typeof webview.cspSource !== "string") throw new TypeError("webview.cspSource is required");
  if (typeof nonce !== "string" || !NONCE_PATTERN.test(nonce)) {
    throw new TypeError("Live Preview nonce must be exactly 24 base64url characters");
  }
  const cspSource = trustedCspSource(webview.cspSource);
  const script = trustedResource(scriptUri, cspSource, "Live Preview script URI");
  const style = trustedResource(styleUri, cspSource, "Live Preview stylesheet URI");
  const csp = `default-src 'none'; script-src 'nonce-${nonce}'; style-src ${cspSource} 'nonce-${nonce}';`;
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
