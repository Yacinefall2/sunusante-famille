import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { SW_NAVIGATE_EVENT } from "../../lib/pwa";

// Clic sur une notification alors que l'application est déjà ouverte : le
// service worker demande d'afficher la page du rappel (accueil, rendez-vous,
// Village…), sans recharger l'application.
export function ServiceWorkerBridge() {
  const navigate = useNavigate();
  useEffect(() => {
    const onNavigate = (e) => {
      const url = String(e.detail || "");
      if (url.startsWith("/") && !url.startsWith("//")) navigate(url);
    };
    window.addEventListener(SW_NAVIGATE_EVENT, onNavigate);
    return () => window.removeEventListener(SW_NAVIGATE_EVENT, onNavigate);
  }, [navigate]);
  return null;
}
