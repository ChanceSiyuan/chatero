import { buildTopicGraph } from "./research-loop-model.mjs";

function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function pageUri(root, path) {
  const base = root.path === "/" ? "" : root.path.replace(/\/+$/u, "");
  return root.with({ path: `${base}/documentation/${path}`, query: "", fragment: "" });
}

function metadata(path, text) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(text)?.[1] ?? "";
  const title = /^title:\s*["']?([^\r\n"']+)["']?\s*$/imu.exec(frontmatter)?.[1]?.trim()
    ?? /^#\s+(.+)$/mu.exec(text)?.[1]?.trim() ?? path.replace(/\.qmd$/iu, "");
  const rawCategories = /^categories:\s*\[([^\]]*)\]\s*$/imu.exec(frontmatter)?.[1] ?? "";
  const categories = rawCategories.split(",").map(value => value.trim().replace(/^['"]|['"]$/gu, "")).filter(Boolean);
  const citations = [...text.matchAll(/\[@([A-Za-z0-9][A-Za-z0-9._:-]{0,255})/gu)].map(value => value[1]);
  return Object.freeze({ categories: Object.freeze([...new Set(categories)]), citations: Object.freeze([...new Set(citations)]), path, text, title });
}

function passiveMarkdown(text) {
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u, "");
  return body.split(/\r?\n/u).map(line => {
    const heading = /^(#{1,6})\s+(.+)$/u.exec(line);
    if (heading) return `<h${heading[1].length}>${escapeHtml(heading[2])}</h${heading[1].length}>`;
    return line.trim() ? `<p>${escapeHtml(line)}</p>` : "";
  }).join("\n");
}

function shell(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title><style>body{font:14px system-ui;margin:0 auto;max-width:960px;padding:2rem;color:var(--vscode-foreground)}nav{display:flex;gap:1rem;flex-wrap:wrap}article{border-top:1px solid var(--vscode-panel-border);margin-top:1.5rem;padding-top:1rem}.node{display:inline-block;border:1px solid currentColor;border-radius:999px;margin:.25rem;padding:.35rem .65rem}</style></head><body>${body}</body></html>`;
}

export function createReviewedResearchSurfaces({ services, vscode } = {}) {
  if (!services?.transactions || !services.scope || !services.workspaceFolderUri
      || typeof vscode?.window?.createWebviewPanel !== "function") {
    throw new TypeError("reviewed Research surface dependencies are invalid");
  }
  const reviewedPages = async () => {
    const state = await services.transactions.state(services.scope);
    const paths = Object.entries(state.documents ?? {})
      .filter(([, value]) => value?.state === "reviewed").map(([path]) => path).sort();
    return Promise.all(paths.map(async path => metadata(path,
      (await vscode.workspace.openTextDocument(pageUri(services.workspaceFolderUri, path))).getText())));
  };
  const panel = (viewType, title, html) => {
    const value = vscode.window.createWebviewPanel(viewType, title, vscode.ViewColumn?.Active, {
      enableScripts: false,
      localResourceRoots: [],
    });
    value.webview.html = html;
    return value;
  };
  return Object.freeze({
    async openTopicGraph() {
      const pages = await reviewedPages();
      const graph = buildTopicGraph({ documents: pages.map(({ categories, citations, path, title }) => ({ categories, citations, path, title })) });
      const body = `<h1>Reviewed Topic Graph</h1><p>${graph.nodes.length} nodes · ${graph.edges.length} links</p>${graph.nodes.map(node => `<span class="node">${escapeHtml(node.label)}</span>`).join("")}`;
      panel("chatero.research.topicGraph", "Reviewed Topic Graph", shell("Reviewed Topic Graph", body));
      return Object.freeze({ kind: "topic-graph-opened", graph });
    },
    async openMainSite() {
      const pages = await reviewedPages();
      const navigation = `<nav>${pages.map(page => `<span>${escapeHtml(page.title)}</span>`).join("")}</nav>`;
      const body = `<h1>Chatero Research</h1>${navigation}${pages.map(page => `<article><h2>${escapeHtml(page.title)}</h2>${passiveMarkdown(page.text)}</article>`).join("")}`;
      panel("chatero.research.mainSite", "Reviewed Main Site", shell("Reviewed Main Site", body));
      return Object.freeze({ kind: "main-site-opened", pages: Object.freeze(pages.map(page => page.path)) });
    },
  });
}
