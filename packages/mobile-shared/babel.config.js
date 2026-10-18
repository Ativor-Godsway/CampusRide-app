// Only used by the jest tests (jest.config.js); the apps bundle this package
// with their own babel config.
module.exports = function (api) {
  api.cache(true);
  return {
    presets: ["babel-preset-expo"],
  };
};
