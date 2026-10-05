import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import api from '../api/client';
import {
  getDefaultFeatureModules,
  getDefaultFeatureRoleAccess,
  canRoleAccessFeature,
} from '../config/featureRegistry';
import { getAccessMatrixRoleDefaults, mergeAccessMatrixRoles } from '../config/accessMatrix';

const FeatureFlagsCtx = createContext({
  modules: getDefaultFeatureModules(),
  roleAccess: { ...getDefaultFeatureRoleAccess(), ...getAccessMatrixRoleDefaults() },
  accessMatrix: [],
  toggleableRoles: [],
  roles: [],
  registry: null,
  loading: true,
  reload: () => {},
  isEnabled: () => true,
  canAccess: () => true,
});

export function FeatureFlagsProvider({ children }) {
  const [modules, setModules] = useState(getDefaultFeatureModules);
  const [roleAccess, setRoleAccess] = useState(() => ({
    ...getDefaultFeatureRoleAccess(),
    ...getAccessMatrixRoleDefaults(),
  }));
  const [accessMatrix, setAccessMatrix] = useState([]);
  const [toggleableRoles, setToggleableRoles] = useState([]);
  const [roles, setRoles] = useState([]);
  const [registry, setRegistry] = useState(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(() => {
    return api.get('/api/features/')
      .then(r => {
        setModules({ ...getDefaultFeatureModules(), ...(r.data?.modules || {}) });
        setRoleAccess(() => {
          const slugs = mergeAccessMatrixRoles(r.data?.toggleableRoles || []);
          const defaults = {
            ...getDefaultFeatureRoleAccess(),
            ...getAccessMatrixRoleDefaults(slugs),
          };
          const stored = r.data?.roleAccess || {};
          const merged = { ...defaults };
          for (const [id, roleMap] of Object.entries(stored)) {
            merged[id] = { ...(defaults[id] || {}), ...(roleMap || {}) };
          }
          return merged;
        });
        setAccessMatrix(r.data?.accessMatrix || []);
        setToggleableRoles(mergeAccessMatrixRoles(r.data?.toggleableRoles || []));
        setRoles(r.data?.roles || []);
        if (r.data?.registry) setRegistry(r.data.registry);
      })
      .catch(() => {
        setModules(getDefaultFeatureModules());
        setRoleAccess({ ...getDefaultFeatureRoleAccess(), ...getAccessMatrixRoleDefaults() });
        setToggleableRoles(mergeAccessMatrixRoles([]));
        setAccessMatrix([]);
        setRoles([]);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const isEnabled = useCallback(
    featureId => !featureId || modules[featureId] !== false,
    [modules],
  );

  const canAccess = useCallback(
    (featureId, role) => canRoleAccessFeature(featureId, role, modules, roleAccess),
    [modules, roleAccess],
  );

  return (
    <FeatureFlagsCtx.Provider value={{
      modules,
      roleAccess,
      accessMatrix,
      toggleableRoles,
      roles,
      registry,
      loading,
      reload,
      isEnabled,
      canAccess,
    }}>
      {children}
    </FeatureFlagsCtx.Provider>
  );
}

export function useFeatureFlags() {
  return useContext(FeatureFlagsCtx);
}
