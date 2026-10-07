import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { Loader2, ShieldX } from "lucide-react";
import { EmergencyView } from "../components/sharing/EmergencyView";

// Fiche d'urgence publique (QR code) : lisible en quelques secondes par un
// secouriste, sans compte ni navigation. Mobile d'abord.
export default function PublicEmergencyPage() {
  const { token } = useParams();
  const [view, setView] = useState(null);
  const [error, setError] = useState(null);
  // Chaque consultation est journalisée côté serveur : un seul appel.
  const requested = useRef(false);

  useEffect(() => {
    document.title = "URGENCE MÉDICALE — SunuSanté";
    if (requested.current) return;
    requested.current = true;
    (async () => {
      try {
        const res = await fetch(`/api/public/emergency/${encodeURIComponent(token)}`, { credentials: "include" });
        if (res.ok) setView(await res.json());
        else setError(res.status === 404 ? "not_found" : "error");
      } catch {
        setError("network");
      }
    })();
  }, [token]);

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-red-600 text-white text-center py-4 px-4 shadow-md">
        <p className="text-2xl sm:text-3xl font-black tracking-wider">URGENCE MÉDICALE</p>
      </header>

      <main className="max-w-xl mx-auto px-4 py-5">
        {!view && !error ? (
          <div className="flex justify-center py-24">
            <Loader2 className="animate-spin text-red-600" size={40} />
          </div>
        ) : error ? (
          <div className="bg-white rounded-2xl border border-gray-200 p-8 text-center mt-6">
            <ShieldX size={40} className="text-red-500 mx-auto mb-3" />
            <p className="text-xl font-bold text-gray-800">
              {error === "not_found" ? "Fiche d'urgence introuvable ou désactivée" : "Chargement impossible"}
            </p>
            {error !== "not_found" && (
              <p className="text-gray-600 mt-2">Vérifiez la connexion Internet puis rechargez la page.</p>
            )}
          </div>
        ) : (
          <EmergencyView view={view} large />
        )}
        <p className="text-xs text-gray-400 text-center mt-8">Fiche d'urgence SunuSanté Famille — informations fournies par la famille.</p>
      </main>
    </div>
  );
}
