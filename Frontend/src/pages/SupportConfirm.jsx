import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";

// Lien de confirmation d'une demande au support (reçu à l'adresse du compte) :
// la demande devient « vérifiée » et part au support.
export default function SupportConfirmPage() {
  const { token } = useParams();
  const [state, setState] = useState({ status: "loading" });
  const done = useRef(false);

  useEffect(() => {
    // Un seul envoi, même en mode strict de React (double effet en développement).
    if (done.current) return;
    done.current = true;
    fetch(`/api/support/public/confirm/${encodeURIComponent(token)}`, { method: "POST" })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (res.ok) setState({ status: "ok", reference: data.reference });
        else setState({ status: "error", message: data.error || "Lien invalide", reference: data.reference });
      })
      .catch(() => setState({ status: "error", message: "Connexion impossible, réessayez." }));
  }, [token]);

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="w-full max-w-sm bg-white rounded-2xl shadow-xl p-8 text-center space-y-3">
        {state.status === "loading" && <Loader2 className="animate-spin text-teal-600 mx-auto" size={36} />}
        {state.status === "ok" && (
          <>
            <CheckCircle2 size={40} className="text-emerald-600 mx-auto" />
            <h1 className="text-xl font-bold text-gray-800">Demande confirmée</h1>
            <p className="text-sm text-gray-600">
              Votre demande <strong>{state.reference}</strong> est transmise au support. Vous recevrez une réponse par courriel.
            </p>
          </>
        )}
        {state.status === "error" && (
          <>
            <XCircle size={40} className="text-red-500 mx-auto" />
            <h1 className="text-xl font-bold text-gray-800">Confirmation impossible</h1>
            <p className="text-sm text-gray-600">{state.message}</p>
          </>
        )}
        <Link to="/login" className="text-teal-600 font-semibold hover:underline text-sm inline-block">
          Aller à la connexion
        </Link>
      </div>
    </div>
  );
}
