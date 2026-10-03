import { Routes, Route, Navigate } from "react-router-dom";
import { FamilyProvider } from "./context/FamilyContext";
import { ProtectedRoute } from "./components/layout/ProtectedRoute";
import LoginPage from "./pages/Login.jsx";
import RegisterPage from "./pages/Register.jsx";
import PendingVerificationPage from "./pages/PendingVerification.jsx";
import VerifyEmailPage from "./pages/VerifyEmail.jsx";
import AcceptInvitationPage from "./pages/AcceptInvitation.jsx";
import DashboardPage from "./pages/Dashboard.jsx";
import MembresPage from "./pages/Membres.jsx";
import RendezVousPage from "./pages/RendezVous.jsx";
import TraitementsPage from "./pages/Traitements.jsx";
import VaccinationsPage from "./pages/Vaccinations.jsx";
import DocumentsPage from "./pages/Documents.jsx";
import FamilySettingsPage from "./pages/FamilySettings.jsx";
import MaFichePage from "./pages/MaFiche.jsx";
import NotificationsPage from "./pages/Notifications.jsx";
import { useFamily } from "./context/FamilyContext";

// Tant que l'utilisateur n'a pas de fiche à lui dans la famille sélectionnée
// (il n'est titulaire d'aucun dossier), il doit d'abord la désigner ou la
// créer — écran bloquant, sur le modèle de la vérification de courriel.
function MyFicheGate({ children }) {
  const { needsMyFiche } = useFamily();
  if (needsMyFiche) return <MaFichePage />;
  return children;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/verification-en-attente" element={<PendingVerificationPage />} />
      <Route path="/verifier-email/:token" element={<VerifyEmailPage />} />
      <Route path="/invitations/:token" element={<AcceptInvitationPage />} />
      <Route
        path="/*"
        element={
          <ProtectedRoute>
            <FamilyProvider>
              <MyFicheGate>
                <Routes>
                  <Route path="/" element={<Navigate to="/dashboard" replace />} />
                  <Route path="/dashboard" element={<DashboardPage />} />
                  <Route path="/membres" element={<MembresPage />} />
                  <Route path="/rendez-vous" element={<RendezVousPage />} />
                  <Route path="/traitements" element={<TraitementsPage />} />
                  <Route path="/vaccinations" element={<VaccinationsPage />} />
                  <Route path="/documents" element={<DocumentsPage />} />
                  <Route path="/famille" element={<FamilySettingsPage />} />
                  <Route path="/notifications" element={<NotificationsPage />} />
                  <Route path="*" element={<Navigate to="/dashboard" replace />} />
                </Routes>
              </MyFicheGate>
            </FamilyProvider>
          </ProtectedRoute>
        }
      />
    </Routes>
  );
}