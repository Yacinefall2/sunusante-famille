import { Routes, Route, Navigate } from "react-router-dom";
import { FamilyProvider } from "./context/FamilyContext";
import { ProtectedRoute } from "./components/layout/ProtectedRoute";
import LoginPage from "./pages/Login.jsx";
import RegisterPage from "./pages/Register.jsx";
import PendingVerificationPage from "./pages/PendingVerification.jsx";
import VerifyEmailPage from "./pages/VerifyEmail.jsx";
import ForgotPasswordPage from "./pages/ForgotPassword.jsx";
import ResetPasswordPage from "./pages/ResetPassword.jsx";
import ConfirmEmailChangePage from "./pages/ConfirmEmailChange.jsx";
import ComptePage from "./pages/Compte.jsx";
import AcceptInvitationPage from "./pages/AcceptInvitation.jsx";
import DashboardPage from "./pages/Dashboard.jsx";
import MembresPage from "./pages/Membres.jsx";
import FichesPage from "./pages/Fiches.jsx";
import RendezVousPage from "./pages/RendezVous.jsx";
import TraitementsPage from "./pages/Traitements.jsx";
import VaccinationsPage from "./pages/Vaccinations.jsx";
import DocumentsPage from "./pages/Documents.jsx";
import FamilySettingsPage from "./pages/FamilySettings.jsx";
import MaFichePage from "./pages/MaFiche.jsx";
import NotificationsPage from "./pages/Notifications.jsx";
import VillagePage from "./pages/Village.jsx";
import PartagePage from "./pages/Partage.jsx";
import JournalPage from "./pages/Journal.jsx";
import PublicDoctorPage from "./pages/PublicDoctor.jsx";
import PublicEmergencyPage from "./pages/PublicEmergency.jsx";
import ExportDownloadPage from "./pages/ExportDownload.jsx";
import SupportAccessPage from "./pages/SupportAccess.jsx";
import SupportConfirmPage from "./pages/SupportConfirm.jsx";
import SupportRequestsPage from "./pages/SupportRequests.jsx";
import { useFamily } from "./context/FamilyContext";
import { SeniorAlerts } from "./components/senior/SeniorAlerts";
import { LocalReminders } from "./components/senior/LocalReminders";
import { ServiceWorkerBridge } from "./components/pwa/ServiceWorkerBridge";

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
    <>
      {/* Clic sur une notification push : ouverture de la bonne page */}
      <ServiceWorkerBridge />
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/verification-en-attente" element={<PendingVerificationPage />} />
        <Route path="/verifier-email/:token" element={<VerifyEmailPage />} />
        <Route path="/mot-de-passe-oublie" element={<ForgotPasswordPage />} />
        <Route path="/reinitialiser-mot-de-passe/:token" element={<ResetPasswordPage />} />
        <Route path="/confirmer-email/:token" element={<ConfirmEmailChangePage />} />
        <Route path="/invitations/:token" element={<AcceptInvitationPage />} />
        {/* Pages publiques de la phase F : sans connexion */}
        <Route path="/medecin/:token" element={<PublicDoctorPage />} />
        <Route path="/urgence/:token" element={<PublicEmergencyPage />} />
        {/* Lien de l'archive de la famille (UC-09) : hors écran « Ma fiche », mais
            la page exige d'être connecté avec le compte du demandeur */}
        <Route path="/export/:token" element={<ExportDownloadPage />} />
        {/* Support (UC-50, UC-51) : « Je n'arrive plus à accéder à mon compte »
            et lien de confirmation d'une demande — sans connexion */}
        <Route path="/support/acces" element={<SupportAccessPage />} />
        <Route path="/support/confirmer/:token" element={<SupportConfirmPage />} />
        <Route
          path="/*"
          element={
            <ProtectedRoute>
              <FamilyProvider>
                {/* Alertes sonores du mode senior (UC-25) : actives sur toutes les pages */}
                <SeniorAlerts />
                {/* Rappels locaux : application ouverte hors ligne (§10) */}
                <LocalReminders />
                <MyFicheGate>
                  <Routes>
                    <Route path="/" element={<Navigate to="/dashboard" replace />} />
                    <Route path="/dashboard" element={<DashboardPage />} />
                    <Route path="/membres" element={<MembresPage />} />
                    <Route path="/fiches" element={<FichesPage />} />
                    <Route path="/rendez-vous" element={<RendezVousPage />} />
                    <Route path="/traitements" element={<TraitementsPage />} />
                    <Route path="/vaccinations" element={<VaccinationsPage />} />
                    <Route path="/documents" element={<DocumentsPage />} />
                    <Route path="/famille" element={<FamilySettingsPage />} />
                    <Route path="/village" element={<VillagePage />} />
                    <Route path="/partage" element={<PartagePage />} />
                    <Route path="/notifications" element={<NotificationsPage />} />
                    <Route path="/journal" element={<JournalPage />} />
                    <Route path="/compte" element={<ComptePage />} />
                    {/* « Contacter le support » et « Mes demandes » */}
                    <Route path="/support" element={<SupportRequestsPage />} />
                    <Route path="*" element={<Navigate to="/dashboard" replace />} />
                  </Routes>
                </MyFicheGate>
              </FamilyProvider>
            </ProtectedRoute>
          }
        />
      </Routes>
    </>
  );
}