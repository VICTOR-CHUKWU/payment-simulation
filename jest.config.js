export default {
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
