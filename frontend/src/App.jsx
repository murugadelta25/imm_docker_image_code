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
import Dashboard from './pages/Dashboard';
import ImmDeviceMonitor from './pages/ImmDeviceMonitor';
import ImmFactoryDashboard from './pages/ImmFactoryDashboard';
import ImmZoneDashboard from './pages/ImmZoneDashboard';
import ImmEquipmentDetail from './pages/ImmEquipmentDetail';
import ImmHistoryList from './pages/ImmHistoryList';
import ImmKpiDashboard from './pages/ImmKpiDashboard';
import DataEntry from './pages/DataEntry';
import ModelChange from './pages/ModelChange';
import Breakdown from './pages/Breakdown';
import MaintenanceDashboard from './pages/MaintenanceDashboard';
import LossTracker from './pages/LossTracker';
import ProductionPlanning from './pages/ProductionPlanning';
import WorkOrderManagement from './pages/WorkOrderManagement';
import EmailAlerts from './pages/EmailAlerts';
import { ConfigProvider } from './context/ConfigContext';
import Configuration from './pages/Configuration';
import FactorySetup from './pages/FactorySetup';
import MachineConfig from './pages/MachineConfig';
import MachineHourlyOutput from './pages/MachineHourlyOutput';
import UserManagement from './pages/UserManagement';
import OperatorWorkInstructionDashboard from './pages/OperatorWorkInstructionDashboard';
import QcApprovals from './pages/QcApprovals';
import PartManagement from './pages/PartManagement';
import ToolManagement from './pages/ToolManagement';
import AutoLogin from './pages/AutoLogin';
import WorkInstructionRevision from './pages/WorkInstructionRevision';
import DatabaseManagement from './pages/DatabaseManagement';
import OperatorManagement from './pages/OperatorManagement';
import MyWorkHours from './pages/MyWorkHours';

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
        <Route path="/dashboard" element={<ImmFactoryDashboard />} />
        <Route path="/imm/zone" element={<ImmZoneDashboard />} />
        <Route path="/imm/zone/:zoneId" element={<ImmZoneDashboard />} />
        <Route path="/imm/equipment" element={<ImmDeviceMonitor />} />
        <Route path="/imm/devices" element={<Navigate to="/imm/equipment" replace />} />
        <Route path="/oee-dashboard" element={<Dashboard />} />
        <Route path="/imm/equipment/:machineId" element={<ImmEquipmentDetail />} />
        <Route path="/imm/kpis" element={<ImmKpiDashboard />} />
        <Route path="/imm/history" element={<Navigate to="/imm/kpis" replace />} />
        <Route path="/imm/history/transfer-rate" element={<Navigate to="/imm/kpis" replace />} />
        <Route path="/imm/history/hit-rate" element={<Navigate to="/imm/kpis" replace />} />
        <Route path="/imm/history/equipment-parameter" element={<Navigate to="/imm/kpis" replace />} />
        <Route path="/imm/history/records" element={<ImmHistoryList />} />
        <Route path="/planning" element={<ProductionPlanning />} />
        <Route path="/work-orders" element={<WorkOrderManagement />} />
        <Route path="/entry" element={<DataEntry />} />
        <Route path="/model-change" element={<ModelChange />} />
        <Route path="/breakdown" element={<Breakdown />} />
        <Route path="/maintenance" element={<MaintenanceDashboard />} />
        <Route path="/loss-tracker" element={<LossTracker />} />
        <Route path="/alerts/email" element={<EmailAlerts />} />
        <Route path="/factory-setup" element={<FactorySetup />} />
        <Route path="/config" element={<Configuration />} />
        <Route path="/machines" element={<MachineConfig />} />
        <Route path="/hourly-output" element={<MachineHourlyOutput />} />
        <Route path="/work-instructions" element={<OperatorWorkInstructionDashboard />} />
        <Route path="/qc-approvals" element={<QcApprovals />} />
        <Route path="/parts" element={<PartManagement />} />
        <Route path="/tools" element={<ToolManagement />} />
        <Route path="/molds" element={<ToolManagement />} />
        <Route path="/wi-revisions" element={<WorkInstructionRevision />} />
        <Route path="/users" element={<UserManagement />} />
        <Route path="/operators" element={<OperatorManagement />} />
        <Route path="/my-work-hours" element={<MyWorkHours />} />
        <Route path="/database-management" element={<DatabaseManagement />} />
        <Route path="*" element={<Navigate to="/dashboard" />} />
      </Route>
      <Route path="*" element={<Navigate to={user ? '/dashboard' : '/login'} />} />
    </Routes>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <FeatureFlagsProvider>
        <PlatformAuthProvider>
          <AuthProvider>
            <BrowserRouter>
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
