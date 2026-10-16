const { withInfoPlist } = require("expo/config-plugins");

/**
 * expo-task-manager's config plugin always adds the iOS "fetch" background
 * mode. CampusRide Driver does no background fetch, only background location
 * while online, and App Review asks about background modes an app doesn't
 * use, so it is taken out again ("location" stays).
 */
module.exports = function withoutBackgroundFetch(config) {
  return withInfoPlist(config, (cfg) => {
    const modes = cfg.modResults.UIBackgroundModes;
    if (Array.isArray(modes))
      cfg.modResults.UIBackgroundModes = modes.filter((mode) => mode !== "fetch");
    return cfg;
  });
};
