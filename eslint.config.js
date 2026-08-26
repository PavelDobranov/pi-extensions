import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      "coverage/**",
      "dist/**",
      "build/**",
      ".cache/**",
      ".tmp/**",
      "tmp/**",
      ".pi/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: "latest",
      globals: globals.node,
    },
  },
  {
    files: ["**/*.{js,cjs}"],
    languageOptions: {
      sourceType: "module",
    },
  },
  {
    files: ["**/*.{ts,tsx,mts,cts}"],
    languageOptions: {
      sourceType: "module",
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", disallowTypeAnnotations: false },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    files: ["extensions/*/**/*.{js,cjs,mjs,ts,tsx,mts,cts}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "../pi-*",
                "../pi-*/**",
                "../../pi-*",
                "../../pi-*/**",
                "../../../pi-*",
                "../../../pi-*/**",
                "../../../../pi-*",
                "../../../../pi-*/**",
              ],
              message:
                "Extensions must not import runtime code from sibling extensions. Declare runtime dependencies in the extension package instead.",
            },
          ],
        },
      ],
    },
  },
);
