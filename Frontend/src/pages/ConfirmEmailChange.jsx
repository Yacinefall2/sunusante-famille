import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Loader2, CheckCircle2, XCircle } from "lucide-react";

// Lien reçu à la nouvelle adresse depuis « Mon compte » : la confirme.
export default function ConfirmEmailChangePage() {
  const { token } = useParams();
  const [status, setStatus] = useState("loading"); // loading | done | error
  const [message, setMessage] = useState("");
  // Un seul appel (lien à usage unique, double montage en développement).
  const requested = useRef(false);

  useEffect(() => {
    if (requested.current) return;
    requested.current = true;
    fetch(`/api/auth/confirm-email-change/${encodeURIComponent(token)}`, { method: "POST" })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
          setMessage(data.email);
          setStatus("done");
        } else {
          setMessage(data.error || "Lien de confirmation invalide");
          setStatus("error");
        }
      })
      .catch(() => {
        setMessage("Vérifiez votre connexion Internet puis rechargez la page.");
        setStatus("error");
      });
  }, [token]);

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="w-full max-w-sm bg-white rounded-2xl shadow-xl p-8 text-center">
        {status === "loading" && (
          <>
            <Loader2 className="animate-spin text-teal-600 mx-auto mb-4" size={36} />
            <p className="text-gray-600">Confirmation de votre nouvelle adresse...</p>
          </>
        )}
        {status === "done" && (
          <>
            <CheckCircle2 className="text-emerald-500 mx-auto mb-4" size={36} />
            <h1 className="text-lg font-bold text-gray-800 mb-1">Adresse modifiée</h1>
            <p className="text-sm text-gray-500 mb-6">
              Utilisez désormais <strong className="break-all">{message}</strong> pour vous connecter.
            </p>
            <Link to="/dashboard" className="text-teal-600 font-semibold hover:underline text-sm">
              Aller à mon espace
            </Link>
          </>
        )}
        {status === "error" && (
          <>
            <XCircle className="text-red-500 mx-auto mb-4" size={36} />
            <h1 className="text-lg font-bold text-gray-800 mb-1">Lien invalide</h1>
            <p className="text-sm text-gray-500 mb-6">{message}</p>
            <Link to="/compte" className="text-teal-600 font-semibold hover:underline text-sm">
              Retour à mon compte
            </Link>
          </>
        )}
      </div>
    </div>
  );
}
