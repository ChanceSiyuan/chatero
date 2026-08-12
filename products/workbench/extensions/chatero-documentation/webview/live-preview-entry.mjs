import { startLivePreview } from "./live-preview-editor.mjs";

const vscode = acquireVsCodeApi();
startLivePreview({ vscode, window, document });
