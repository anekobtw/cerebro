import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
    alias: {
      "expo-constants": fileURLToPath(
        new URL("./tools/testing/expo-constants.ts", import.meta.url),
      ),
    },
  },
});
