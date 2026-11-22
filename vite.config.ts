import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: { ignorePatterns: ["apps/desktop/src/ipc/bindings/protocol.ts"] },
  lint: {
    categories: { correctness: "error" },
    options: { typeAware: true, typeCheck: true },
  },
});
