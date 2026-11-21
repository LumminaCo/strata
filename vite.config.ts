import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {},
  lint: {
    categories: { correctness: "error" },
    options: { typeAware: true, typeCheck: true },
  },
});
