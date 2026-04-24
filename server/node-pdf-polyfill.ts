/**
 * pdfjs-dist 5.x 在 Node 20 上会调用 process.getBuiltinModule（Node 22+ 才有），
 * 缺省时产生大量 Warning；此处补一层最小 shim。
 */
import { createRequire } from "node:module"

const proc = process as NodeJS.Process & {
  getBuiltinModule?: (id: string) => unknown
}

if (typeof proc.getBuiltinModule !== "function") {
  const require = createRequire(import.meta.url)
  proc.getBuiltinModule = function getBuiltinModule(id: string): unknown {
    try {
      if (id === "module") return require("module")
      if (id === "fs") return require("fs")
      if (id === "fs/promises") return require("fs/promises")
      if (id === "url") return require("url")
      if (id === "stream") return require("stream")
      if (id === "crypto") return require("crypto")
    } catch {
      /* ignore */
    }
    return undefined
  }
}
