/**
 * Component and navigation tests for the shared mobile code, run with the
 * real expo-router in a simulated React Native environment (jest-expo).
 * Plain domain logic is tested in packages/shared with vitest instead.
 */
module.exports = {
  preset: "jest-expo",
  testMatch: ["<rootDir>/src/**/*.test.ts?(x)"],
  moduleNameMapper: {
    "^@rida/shared$": "<rootDir>/../shared/src/index.ts",
  },
  setupFiles: ["<rootDir>/src/__tests__/setup.ts"],
};
