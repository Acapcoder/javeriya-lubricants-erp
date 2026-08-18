import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth/AuthContext';
import { LoginPage } from './auth/LoginPage';
import { TwoFactorEnroll } from './auth/TwoFactorEnroll';
import { TwoFactorVerify } from './auth/TwoFactorVerify';
import { AppShell } from './shell/AppShell';
import { DashboardPage } from './pages/DashboardPage';
import { PurchasesPage } from './pages/PurchasesPage';
import { InventoryPage } from './pages/InventoryPage';
import { SuppliersPage } from './pages/SuppliersPage';
import { ReportsPage } from './pages/ReportsPage';
import { SpendingPage } from './pages/SpendingPage';
import { PaymentsPage } from './pages/PaymentsPage';
import { WeightFeesPage } from './pages/WeightFeesPage';
import { JournalPage } from './pages/JournalPage';
import { UsersPage } from './pages/UsersPage';
import { DriversPage } from './pages/DriversPage';
import { FinancePage } from './pages/FinancePage';
import { ProfilesPage } from './pages/ProfilesPage';
import { PlaceholderPage } from './pages/PlaceholderPage';

function Gate() {
  const { stage } = useAuth();

  if (stage === 'loading') return <div className="centered-loading">Loading…</div>;
  if (stage === 'anonymous') return <LoginPage />;
  if (stage === 'two-factor-enroll') return <TwoFactorEnroll />;
  if (stage === 'two-factor-verify') return <TwoFactorVerify />;

  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/purchases" element={<PurchasesPage />} />
        <Route path="/inventory" element={<InventoryPage />} />
        <Route path="/admin/contacts" element={<SuppliersPage />} />
        <Route path="/suppliers" element={<SuppliersPage />} />
        <Route path="/reports/operations" element={<ReportsPage />} />
        <Route path="/finance/expenses" element={<SpendingPage />} />
        <Route path="/finance/payments" element={<PaymentsPage />} />
        <Route path="/finance/weight-fees" element={<WeightFeesPage />} />
        <Route path="/finance/journal" element={<JournalPage />} />
        <Route path="/admin/users" element={<UsersPage />} />
        <Route path="/finance/pnl" element={<ReportsPage />} />
        <Route path="/drivers" element={<DriversPage />} />
        <Route path="/admin/drivers" element={<DriversPage />} />
        <Route path="/finance" element={<FinancePage />} />
        <Route path="/finance/ledgers" element={<FinancePage />} />
        <Route path="/admin/profiles" element={<ProfilesPage />} />
        <Route path="*" element={<PlaceholderPage />} />
      </Routes>
    </AppShell>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Gate />
      </AuthProvider>
    </BrowserRouter>
  );
}
