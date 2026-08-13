import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { CORE_ATTACHMENT_MAX_READ_BYTES, openCoreAttachmentSource } from "./core-attachment-source.mjs";

export class CorePdfMaterializer {
  #request;
  #rootDirectory;

  constructor({ request, rootDirectory } = {}) {
    if (typeof request !== "function" || typeof rootDirectory !== "string" || !isAbsolute(rootDirectory)) {
      throw new TypeError("PDF materializer requires Core RPC and an absolute local cache root");
    }
    this.#request = request;
    this.#rootDirectory = rootDirectory;
  }

  async materialize(record) {
    const source = await openCoreAttachmentSource(record, { request: this.#request });
    const directory = join(this.#rootDirectory, `pdf-${randomBytes(18).toString("base64url")}`);
    const path = join(directory, "paper.pdf");
    let handle;
    let disposed = false;
    try {
      await mkdir(this.#rootDirectory, { recursive: true, mode: 0o700 });
      await chmod(this.#rootDirectory, 0o700);
      await mkdir(directory, { recursive: false, mode: 0o700 });
      await chmod(directory, 0o700);
      handle = await open(path, "wx", 0o600);
      let offset = 0;
      while (offset < source.size) {
        const length = Math.min(CORE_ATTACHMENT_MAX_READ_BYTES, source.size - offset);
        const bytes = await source.read(offset, length);
        const written = await handle.write(bytes, 0, bytes.byteLength, offset);
        if (written.bytesWritten !== bytes.byteLength) throw new Error("Could not materialize the complete Zotero PDF chunk");
        offset += bytes.byteLength;
      }
      await handle.sync();
      await handle.close();
      handle = null;
      await source.close();
      return Object.freeze({
        path,
        async dispose() {
          if (disposed) return;
          disposed = true;
          await rm(directory, { recursive: true, force: true });
        },
      });
    }
    catch (error) {
      await handle?.close().catch(() => {});
      await source.close().catch(() => {});
      await rm(directory, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }
}
