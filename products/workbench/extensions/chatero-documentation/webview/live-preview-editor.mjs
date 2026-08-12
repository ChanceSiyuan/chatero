import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

export function startLivePreview({ vscode, document }) {
  const mount = document.querySelector("[data-documentation-editor]");
  if (!mount) throw new Error("Documentation editor mount is missing");
  const state = EditorState.create({
    doc: "",
    extensions: [EditorView.editable.of(false)],
  });
  const view = new EditorView({ parent: mount, state });
  vscode.postMessage(Object.freeze({ type: "ready" }));
  return Object.freeze({ dispose: () => view.destroy() });
}
