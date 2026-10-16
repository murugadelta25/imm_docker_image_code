/** Re-exports from feature registry (backward compatibility). */
export {
  getDefaultFeatureModules as DEFAULT_FEATURE_MODULES,
  isRouteEnabled,
  pathToFeatureId as moduleForPath,
  isFeatureEnabled,
} from '../config/featureRegistry';
