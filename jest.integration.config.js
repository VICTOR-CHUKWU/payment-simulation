export default {
  extensionsToTreatAsEsm: [".ts"],
  maxWorkers: 1,
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  roots: ["<rootDir>/tests/integration"],
  testEnvironmentOptions: {
    customExportConditions: ["development", "node", "node-addons"],
  },
  testMatch: ["**/*.int.test.ts"],
  testTimeout: 30_000,
  transform: {
    "^.+\\.ts$": ["ts-jest", { tsconfig: "tsconfig.test.json", useESM: true }],
  },
};
