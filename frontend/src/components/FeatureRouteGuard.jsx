import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useFeatureFlags } from '../context/FeatureFlagsContext';
import { firstAllowedPath, isRouteEnabled } from '../config/featureRegistry';

/** Redirect to the first allowed page when a disabled feature route is opened. */
export default function FeatureRouteGuard({ children }) {
  const { pathname } = useLocation();
  const { user } = useAuth();
  const { modules, roleAccess, loading } = useFeatureFlags();

  if (loading) return children;

  if (pathname.startsWith('/platform')) return children;

  if (!isRouteEnabled(pathname, modules, user?.role, roleAccess)) {
    const fallback = firstAllowedPath(user?.role, modules, roleAccess);
    if (fallback === pathname) return children;
    return <Navigate to={fallback} replace />;
  }

  return children;
}
