import eslint from "@eslint/js";
import jsxA11y from "eslint-plugin-jsx-a11y";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

const typeScriptFiles = [
  "apps/**/*.{ts,tsx}",
  "packages/**/*.{ts,tsx}",
  "tests/**/*.ts",
  "playwright.config.ts",
];
const typeScriptFilesWithoutAProject = [
  "packages/**/tests/**/*.{ts,tsx}",
  "packages/**/vitest.config.ts",
  "tests/**/*.ts",
  "playwright.config.ts",
];

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/coverage/**",
      "**/node_modules/**",
      "**/.tmp/**",
      "**/.tmp-*/**",
      "**/target/**",
      "DESIGN/**",
      "Design-temp/**",
      "playwright-report/**",
      "test-results/**",
    ],
  },
  {
    ...eslint.configs.recommended,
    files: ["*.{js,mjs}", "scripts/**/*.{js,mjs}"],
    languageOptions: {
      globals: {
        process: "readonly",
      },
    },
  },
  ...tseslint.configs.strictTypeChecked.map((configuration) => ({
    ...configuration,
    files: typeScriptFiles,
  })),
  ...tseslint.configs.stylisticTypeChecked.map((configuration) => ({
    ...configuration,
    files: typeScriptFiles,
  })),
  {
    files: typeScriptFiles,
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      "jsx-a11y": jsxA11y,
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...jsxA11y.flatConfigs.recommended.rules,
      ...reactHooks.configs.flat.recommended.rules,
      "@typescript-eslint/consistent-type-exports": "error",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        {
          fixStyle: "inline-type-imports",
          prefer: "type-imports",
        },
      ],
      "@typescript-eslint/no-confusing-void-expression": [
        "error",
        {
          ignoreArrowShorthand: true,
        },
      ],
      "@typescript-eslint/no-misused-promises": [
        "error",
        {
          checksVoidReturn: {
            attributes: false,
          },
        },
      ],
      "react-refresh/only-export-components": [
        "warn",
        {
          allowConstantExport: true,
        },
      ],
    },
  },
  {
    ...tseslint.configs.disableTypeChecked,
    files: typeScriptFilesWithoutAProject,
  },
  {
    files: ["packages/ui/**/*.{ts,tsx}"],
    rules: {
      "react-refresh/only-export-components": "off",
    },
  },
);
