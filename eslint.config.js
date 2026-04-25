import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "coverage/**",
      "eslint.config.js",
      "prettier.config.js",
      "scripts/**",
      // SvelteKit has its own toolchain (svelte-check) and emits generated
      // files under .svelte-kit/ that are not in any tsconfig project.
      "apps/web/**",
    ],
  },
);
