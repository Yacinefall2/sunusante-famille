import { useCallback, useEffect, useState } from "react";
import { Link, Navigate, useLocation, useParams } from "react-router-dom";
import { Archive, Download, Heart, Loader2, ShieldAlert, XCircle, CheckCircle2 } from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { openPrivateLink } from "../lib/session";
import { formatDateTime } from "../lib/utils";

// Lien reçu par courriel pour télécharger l'archive des données de la famille
// (UC-09) : /export/<jeton>. Le lien seul ne suffit pas — il faut être
// connecté avec le compte qui a demandé l'archive (sinon : connexion, puis
// retour ici). Usage unique, valable 1 heure.

function Shell({ children }) {
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-xl p-8">
        <div className="flex flex-col items-center mb-6">
          <div className="w-12 h-12 bg-gradient-to-br from-teal-500 to-blue-600 rounded-xl flex items-center justify-center shadow-md mb-3">
            <Heart size={22} className="text-white" />
          </div>
          <h1 className="text-xl font-bold text-gray-800 text-center">Archive des données de la famille</h1>
        </div>
        {children}
      </div>
    </div>
  );
}

const formatSize = (bytes) => (bytes ? `${(bytes / (1024 * 1024)).toFixed(1).replace(".", ",")} Mo` : null);

export default function ExportDownloadPage() {
  const { token } = useParams();
  const location = useLocation();
  const { user, loading: authLoading } = useAuth();
  const [info, setInfo] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [clicked, setClicked] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/exports/${encodeURIComponent(token)}`);
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setInfo(data);
        setError(null);
      } else {
        setError(data.error || "Lien invalide");
      }
    } catch {
      setError("Impossible de vérifier ce lien. Vérifiez votre connexion et réessayez.");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    if (user?.emailVerified) load();
  }, [user, load]);

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <Loader2 className="animate-spin text-teal-600" size={40} />
      </div>
    );
  }
  // Pas connecté : connexion d'abord, puis retour sur ce lien.
  if (!user) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname)}`} replace />;
  if (!user.emailVerified) return <Navigate to="/verification-en-attente" replace />;

  const startDownload = (event) => {
    setClicked(true);
    openPrivateLink(event);
    // Le téléchargement consomme le lien : l'état est relu peu après.
    setTimeout(load, 4000);
  };

  let content;
  if (loading) {
    content = (
      <div className="flex justify-center py-6">
        <Loader2 className="animate-spin text-teal-600" size={28} />
      </div>
    );
  } else if (error) {
    content = (
      <div className="space-y-4">
        <p className="flex items-start gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl p-3">
          <XCircle size={16} className="flex-shrink-0 mt-0.5" />
          <span>{error}</span>
        </p>
        <p className="text-xs text-gray-500">Connecté(e) en tant que {user.name} ({user.email}).</p>
      </div>
    );
  } else if (info.status === "ready") {
    content = (
      <div className="space-y-4">
        <p className="text-sm text-gray-600">
          L&apos;archive de la famille <strong>{info.familyName}</strong>
          {formatSize(info.sizeBytes) ? ` (${formatSize(info.sizeBytes)})` : ""} est prête. Ce lien ne sert qu&apos;une fois
          et expire le {formatDateTime(info.expiresAt)} : une fois téléchargée, elle est effacée du serveur.
        </p>
        <p className="flex items-start gap-2 text-xs text-amber-900 bg-amber-50 border border-amber-200 rounded-xl p-3">
          <ShieldAlert size={15} className="flex-shrink-0 mt-0.5" />
          <span>
            Elle contient des données de santé confidentielles : enregistrez-la dans un endroit sûr et ne la transmettez
            qu&apos;à des personnes de confiance.
          </span>
        </p>
        <a
          href={`/api/exports/${encodeURIComponent(token)}/download`}
          download
          onClick={startDownload}
          className="w-full inline-flex items-center justify-center gap-2 font-semibold rounded-xl transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-offset-2 text-base px-6 py-3 bg-teal-600 hover:bg-teal-700 text-white focus:ring-teal-500 shadow-sm"
        >
          <Download size={18} />
          Télécharger l&apos;archive
        </a>
        {clicked && <p className="text-xs text-gray-500 text-center">Téléchargement en cours…</p>}
      </div>
    );
  } else {
    const messages = {
      downloaded: "Cette archive a déjà été téléchargée : elle a été effacée du serveur.",
      expired: "Ce lien a expiré. Vous pouvez demander une nouvelle archive depuis « Comptes & invitations ».",
      pending: "L'archive est encore en préparation : réessayez dans quelques instants.",
      failed: "La préparation de cette archive a échoué. Demandez-en une nouvelle depuis « Comptes & invitations ».",
    };
    const done = info.status === "downloaded";
    content = (
      <p
        className={`flex items-start gap-2 text-sm rounded-xl p-3 border ${
          done ? "text-emerald-800 bg-emerald-50 border-emerald-200" : "text-gray-700 bg-gray-50 border-gray-200"
        }`}
      >
        {done ? <CheckCircle2 size={16} className="flex-shrink-0 mt-0.5" /> : <Archive size={16} className="flex-shrink-0 mt-0.5" />}
        <span>
          {messages[info.status] ?? "Ce lien n'est plus valable."}
          {done && info.downloadedAt ? ` (le ${formatDateTime(info.downloadedAt)})` : ""}
        </span>
      </p>
    );
  }

  return (
    <Shell>
      {content}
      <div className="mt-6 text-center">
        <Link to="/famille" className="text-sm font-semibold text-teal-600 hover:underline">
          Retour à l&apos;application
        </Link>
      </div>
    </Shell>
  );
}
