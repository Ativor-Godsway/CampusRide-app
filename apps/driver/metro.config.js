const { getDefaultConfig } = require("expo/metro-config");

// Expo's metro-config has handled npm-workspaces monorepos natively since
// SDK 52: it sets watchFolders, resolver.nodeModulesPaths,
// resolver.extraNodeModules and resolver.disableHierarchicalLookup itself.
//
// This file used to override all four by hand (the pre-SDK-52 recipe). Those
// overrides REPLACED rather than extended Expo's defaults, which expo-doctor
// flagged during the SDK 54 -> 57 upgrade, so they are gone. Sibling
// workspace sources (@rida/shared, @rida/mobile-shared) still resolve — see
// the bundle check in the Phase 3B notes.
module.exports = getDefaultConfig(__dirname);
