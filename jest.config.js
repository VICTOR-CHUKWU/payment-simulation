export default {
  collectCoverageFrom: [
    "{libs,services}/*/src/**/*.ts",
    "!**/*.test.ts",
    "!**/index.ts",
    "!services/*/src/main.ts",
  ],
  coverageProvider: "v8",
  coverageReporters: ["text", "text-summary", "html"],
  extensionsToTreatAsEsm: [".ts"],
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  roots: ["<rootDir>/libs", "<rootDir>/services"],
  testEnvironmentOptions: {
    customExportConditions: ["development", "node", "node-addons"],
  },
  transform: {
    "^.+\\.ts$": ["ts-jest", { tsconfig: "tsconfig.test.json", useESM: true }],
  },
};
