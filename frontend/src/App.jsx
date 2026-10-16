import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { PlatformAuthProvider } from './context/PlatformAuthContext';
import { FeatureFlagsProvider } from './context/FeatureFlagsContext';
import { ThemeProvider } from './context/ThemeContext';
import { BrandingProvider } from './context/BrandingContext';
import { EmbedProvider } from './context/EmbedContext';
import AppShell from './components/layout/AppShell';
import IdleTimeoutGuard from './components/IdleTimeoutGuard';
import FeatureRouteGuard from './components/FeatureRouteGuard';
import Login from './pages/Login';
import PlatformLogin from './pages/platform/PlatformLogin';
import FeatureModulesAdmin from './pages/platform/FeatureModulesAdmin';
import { ConfigProvider } from './context/ConfigContext';
import AutoLogin from './pages/AutoLogin';

// Lazy-load page components for code splitting
const Dashboard = lazy(() => import('./pages/Dashboard'));
const ImmDeviceMonitor = lazy(() => import('./pages/ImmDeviceMonitor'));
const ImmFactoryDashboard = lazy(() => import('./pages/ImmFactoryDashboard'));
const ImmZoneDashboard = lazy(() => import('./pages/ImmZoneDashboard'));
const ImmEquipmentDetail = lazy(() => import('./pages/ImmEquipmentDetail'));
const ImmHistoryList = lazy(() => import('./pages/ImmHistoryList'));
const ImmKpiDashboard = lazy(() => import('./pages/ImmKpiDashboard'));
const ImmEnergyDashboard = lazy(() => import('./pages/ImmEnergyDashboard'));
const DataEntry = lazy(() => import('./pages/DataEntry'));
const ModelChange = lazy(() => import('./pages/ModelChange'));
const Breakdown = lazy(() => import('./pages/Breakdown'));
const MaintenanceDashboard = lazy(() => import('./pages/MaintenanceDashboard'));
const LossTracker = lazy(() => import('./pages/LossTracker'));
const ProductionPlanning = lazy(() => import('./pages/ProductionPlanning'));
const WorkOrderManagement = lazy(() => import('./pages/WorkOrderManagement'));
const EmailAlerts = lazy(() => import('./pages/EmailAlerts'));
const Configuration = lazy(() => import('./pages/Configuration'));
const FactorySetup = lazy(() => import('./pages/FactorySetup'));
const MachineConfig = lazy(() => import('./pages/MachineConfig'));
const MachineHourlyOutput = lazy(() => import('./pages/MachineHourlyOutput'));
const UserManagement = lazy(() => import('./pages/UserManagement'));
const OperatorWorkInstructionDashboard = lazy(() => import('./pages/OperatorWorkInstructionDashboard'));
const QcApprovals = lazy(() => import('./pages/QcApprovals'));
const PartManagement = lazy(() => import('./pages/PartManagement'));
const ToolManagement = lazy(() => import('./pages/ToolManagement'));
const WorkInstructionRevision = lazy(() => import('./pages/WorkInstructionRevision'));
const DatabaseManagement = lazy(() => import('./pages/DatabaseManagement'));
const OperatorManagement = lazy(() => import('./pages/OperatorManagement'));
const MyWorkHours = lazy(() => import('./pages/MyWorkHours'));

// Loading fallback component
function PageLoadingFallback() {
  return (
    <div style={{ 
      display: 'flex', 
      alignItems: 'center', 
      justifyContent: 'center', 
      height: '100vh',
      background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
      color: '#fff',
      fontSize: '18px',
      fontFamily: 'system-ui'
    }}>
      <div>Loading...</div>
    </div>
  );
}

/** CPLM Root + Outlet pattern — shell wraps all authenticated routes */
function AuthenticatedShell() {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  return (
    <IdleTimeoutGuard>
      <FeatureRouteGuard>
        <AppShell />
      </FeatureRouteGuard>
    </IdleTimeoutGuard>
  );
}

function AppRoutes() {
  const { user } = useAuth();

  return (
    <Routes>
      <Route path="/platform/login" element={<PlatformLogin />} />
      <Route path="/platform/modules" element={<FeatureModulesAdmin />} />
      <Route path="/platform" element={<Navigate to="/platform/login" replace />} />

      <Route path="/login" element={<Login />} />
      <Route path="/autologin" element={<AutoLogin />} />
      <Route element={<AuthenticatedShell />}>
        <Route 
          path="/dashboard" 
          element={
            <Suspense fallback={<PageLoadingFallback />}>
              <ImmFactoryDashboard />
            </Suspense>
          } 
        />
        <Route 
          path="/imm/zone" 
          element={
            <Suspense fallback={<PageLoadingFallback />}>
              <ImmZoneDashboard />
            </Suspense>
          } 
        />
        <Route 
          path="/imm/zone/:zoneId" 
          element={
            <Suspense fallback={<PageLoadingFallback />}>
              <ImmZoneDashboard />
            </Suspense>
          } 
        />
        <Route 
          path="/imm/equipment" 
          element={
            <Suspense fallback={<PageLoadingFallback />}>
              <ImmDeviceMonitor />
            </Suspense>
          } 
        />
        <Route path="/imm/devices" element={<Navigate to="/imm/equipment" replace />} />
        <Route 
          path="/oee-dashboard" 
          element={
            <Suspense fallback={<PageLoadingFallback />}>
              <Dashboard />
            </Suspense>
          } 
        />
        <Route 
          path="/imm/equipment/:machineId" 
          element={
            <Suspense fallback={<PageLoadingFallback />}>
              <ImmEquipmentDetail />
            </Suspense>
          } 
        />
        <Route 
          path="/imm/kpis" 
          element={
            <Suspense fallback={<PageLoadingFallback />}>
              <ImmKpiDashboard />
            </Suspense>
          } 
        />
        <Route 
          path="/imm/energy" 
          element={
            <Suspense fallback={<PageLoadingFallback />}>
              <ImmEnergyDashboard />
            </Suspense>
          } 
        />
        <Route path="/imm/history" element={<Navigate to="/imm/kpis" replace />} />
        <Route path="/imm/history/transfer-rate" element={<Navigate to="/imm/kpis" replace />} />
        <Route path="/imm/history/hit-rate" element={<Navigate to="/imm/kpis" replace />} />
        <Route path="/imm/history/equipment-parameter" element={<Navigate to="/imm/kpis" replace />} />
        <Route 
          path="/imm/history/records" 
          element={
            <Suspense fallback={<PageLoadingFallback />}>
              <ImmHistoryList />
            </Suspense>
          } 
        />
        <Route 
          path="/planning" 
          element={
            <Suspense fallback={<PageLoadingFallback />}>
              <ProductionPlanning />
            </Suspense>
          } 
        />
        <Route 
          path="/work-orders" 
          element={
            <Suspense fallback={<PageLoadingFallback />}>
              <WorkOrderManagement />
            </Suspense>
          } 
        />
        <Route 
          path="/entry" 
          element={
            <Suspense fallback={<PageLoadingFallback />}>
              <DataEntry />
            </Suspense>
          } 
        />
        <Route 
          path="/model-change" 
          element={
            <Suspense fallback={<PageLoadingFallback />}>
              <ModelChange />
            </Suspense>
          } 
        />
        <Route 
          path="/breakdown" 
          element={
            <Suspense fallback={<PageLoadingFallback />}>
              <Breakdown />
            </Suspense>
          } 
        />
        <Route 
          path="/maintenance" 
          element={
            <Suspense fallback={<PageLoadingFallback />}>
              <MaintenanceDashboard />
            </Suspense>
          } 
        />
        <Route 
          path="/loss-tracker" 
          element={
            <Suspense fallback={<PageLoadingFallback />}>
              <LossTracker />
            </Suspense>
          } 
        />
        <Route 
          path="/alerts/email" 
          element={
            <Suspense fallback={<PageLoadingFallback />}>
              <EmailAlerts />
            </Suspense>
          } 
        />
        <Route 
          path="/factory-setup" 
          element={
            <Suspense fallback={<PageLoadingFallback />}>
              <FactorySetup />
            </Suspense>
          } 
        />
        <Route 
          path="/config" 
          element={
            <Suspense fallback={<PageLoadingFallback />}>
              <Configuration />
            </Suspense>
          } 
        />
        <Route 
          path="/machines" 
          element={
            <Suspense fallback={<PageLoadingFallback />}>
              <MachineConfig />
            </Suspense>
          } 
        />
        <Route 
          path="/hourly-output" 
          element={
            <Suspense fallback={<PageLoadingFallback />}>
              <MachineHourlyOutput />
            </Suspense>
          } 
        />
        <Route 
          path="/work-instructions" 
          element={
            <Suspense fallback={<PageLoadingFallback />}>
              <OperatorWorkInstructionDashboard />
            </Suspense>
          } 
        />
        <Route 
          path="/qc-approvals" 
          element={
            <Suspense fallback={<PageLoadingFallback />}>
              <QcApprovals />
            </Suspense>
          } 
        />
        <Route 
          path="/parts" 
          element={
            <Suspense fallback={<PageLoadingFallback />}>
              <PartManagement />
            </Suspense>
          } 
        />
        <Route 
          path="/tools" 
          element={
            <Suspense fallback={<PageLoadingFallback />}>
              <ToolManagement />
            </Suspense>
          } 
        />
        <Route 
          path="/molds" 
          element={
            <Suspense fallback={<PageLoadingFallback />}>
              <ToolManagement />
            </Suspense>
          } 
        />
        <Route 
          path="/wi-revisions" 
          element={
            <Suspense fallback={<PageLoadingFallback />}>
              <WorkInstructionRevision />
            </Suspense>
          } 
        />
        <Route 
          path="/users" 
          element={
            <Suspense fallback={<PageLoadingFallback />}>
              <UserManagement />
            </Suspense>
          } 
        />
        <Route 
          path="/operators" 
          element={
            <Suspense fallback={<PageLoadingFallback />}>
              <OperatorManagement />
            </Suspense>
          } 
        />
        <Route 
          path="/my-work-hours" 
          element={
            <Suspense fallback={<PageLoadingFallback />}>
              <MyWorkHours />
            </Suspense>
          } 
        />
        <Route 
          path="/database-management" 
          element={
            <Suspense fallback={<PageLoadingFallback />}>
              <DatabaseManagement />
            </Suspense>
          } 
        />
        <Route path="*" element={<Navigate to="/dashboard" />} />
      </Route>
      <Route path="*" element={<Navigate to={user ? '/dashboard' : '/login'} />} />
    </Routes>
  );
}

const routerBasename = (() => {
  const raw = (import.meta.env.BASE_URL || '/').replace(/\/$/, '')
  return raw || undefined
})()

export default function App() {
  return (
    <ThemeProvider>
      <FeatureFlagsProvider>
        <PlatformAuthProvider>
          <AuthProvider>
            <BrowserRouter basename={routerBasename}>
              <BrandingProvider>
                <EmbedProvider>
                  <ConfigProvider>
                    <AppRoutes />
                  </ConfigProvider>
                </EmbedProvider>
              </BrandingProvider>
            </BrowserRouter>
          </AuthProvider>
        </PlatformAuthProvider>
      </FeatureFlagsProvider>
    </ThemeProvider>
  );
}
