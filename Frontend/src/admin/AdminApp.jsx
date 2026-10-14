import { Navigate, Route, Routes } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { AdminAuthProvider, useAdminAuth } from "./AdminAuthContext";
import { AdminLayout } from "./AdminLayout";
import AdminLoginPage from "./pages/AdminLogin.jsx";
import AdminHomePage from "./pages/AdminHome.jsx";
import AdminRequestsPage from "./pages/AdminRequests.jsx";
import AdminRequestDetailPage from "./pages/AdminRequestDetail.jsx";
import AdminAccountsPage from "./pages/AdminAccounts.jsx";
import AdminAccountDetailPage from "./pages/AdminAccountDetail.jsx";
import AdminLogsPage from "./pages/AdminLogs.jsx";
import AdminAuditPage from "./pages/AdminAudit.jsx";

// Espace support (acteur A5, /admin) : entièrement séparé de l'application
// famille — ni FamilyProvider, ni écran « Ma fiche », ni session famille.
function AdminRoutes() {
  const { supportUser, loading } = useAdminAuth();
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <Loader2 className="animate-spin text-slate-500" size={36} />
      </div>
    );
  }
  if (!supportUser) return <AdminLoginPage />;
  return (
    <AdminLayout>
      <Routes>
        <Route path="/admin" element={<AdminHomePage />} />
        <Route path="/admin/demandes" element={<AdminRequestsPage />} />
        <Route path="/admin/demandes/:id" element={<AdminRequestDetailPage />} />
        <Route path="/admin/comptes" element={<AdminAccountsPage />} />
        <Route path="/admin/comptes/:id" element={<AdminAccountDetailPage />} />
        <Route path="/admin/journaux" element={<AdminLogsPage />} />
        <Route path="/admin/audit" element={<AdminAuditPage />} />
        <Route path="*" element={<Navigate to="/admin" replace />} />
      </Routes>
    </AdminLayout>
  );
}

export default function AdminApp() {
  return (
    <AdminAuthProvider>
      <AdminRoutes />
    </AdminAuthProvider>
  );
}
