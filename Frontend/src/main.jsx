import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { Toaster } from "react-hot-toast";
import App from "./App.jsx";
import { AuthProvider, useAuth } from "./context/AuthContext.jsx";
import { ErrorBoundary } from "./components/ErrorBoundary.jsx";
import { installFetchInterceptor } from "./lib/session.js";
import { installOnlineListeners } from "./lib/offline.js";
import { captureInstallPrompt, registerServiceWorker } from "./lib/pwa.js";
import "./index.css";

// Renouvellement automatique de la session sur les réponses 401 (voir
// lib/session.js) — installé avant tout appel réseau de l'application.
installFetchInterceptor();
// Application installable : état du réseau, service worker (hors ligne,
// notifications push) et bouton « Installer l'application ».
installOnlineListeners();
captureInstallPrompt();
registerServiceWorker();

// Confirmations (toasts) : plus grandes et plus longues en mode senior (UC-25).
function AppToaster() {
  const { seniorMode } = useAuth();
  return (
    <Toaster
      position={seniorMode ? "top-center" : "top-right"}
      toastOptions={{
        duration: seniorMode ? 7000 : undefined,
        style: {
          borderRadius: "12px",
          background: "#1f2937",
          color: "#fff",
          fontSize: seniorMode ? "20px" : "14px",
          ...(seniorMode ? { padding: "16px 20px", maxWidth: "560px", fontWeight: 600 } : {}),
        },
        success: { iconTheme: { primary: "#10b981", secondary: "#fff" }, ...(seniorMode ? { duration: 7000 } : {}) },
        error: { iconTheme: { primary: "#ef4444", secondary: "#fff" }, ...(seniorMode ? { duration: 9000 } : {}) },
      }}
    />
  );
}

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <AuthProvider>
          <App />
          <AppToaster />
        </AuthProvider>
      </BrowserRouter>
    </ErrorBoundary>
  </StrictMode>
);
