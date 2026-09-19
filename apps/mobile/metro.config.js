const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

config.resolver.resolveRequest = (context, moduleName, platform) => {
  try {
    return context.resolveRequest(context, moduleName, platform);
  } catch (error) {
    if (moduleName.startsWith(".") && moduleName.endsWith(".js")) {
      return context.resolveRequest(
        context,
        moduleName.slice(0, -".js".length),
        platform,
      );
    }

    throw error;
  }
};

module.exports = config;
