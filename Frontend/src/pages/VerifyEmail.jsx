import { useEffect, useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { Loader2, CheckCircle2, XCircle } from "lucide-react";

// Écran affiché lorsqu'on clique le bouton "Accéder à mon compte" du
// courriel de vérification. Consomme le lien, puis redirige automatiquement
// dans l'application (le backend a ouvert la session au passage).
export default function VerifyEmailPage() {
  const { token } = useParams();
  const { verifyEmail } = useAuth();
  const navigate = useNavigate();
  const [status, setStatus] = useState("loading"); // loading | success | error
  const [error, setError] = useState("");

  useEffect(() => {
    verifyEmail(token)
      .then(() => {
        setStatus("success");
        setTimeout(() => navigate("/dashboard"), 1200);
      })
      .catch((err) => {
        setStatus("error");
        setError(err.message);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="w-full max-w-sm bg-white rounded-2xl shadow-xl p-8 text-center">
        {status === "loading" && (
          <>
            <Loader2 className="animate-spin text-teal-600 mx-auto mb-4" size={36} />
            <p className="text-gray-600">Vérification de votre adresse en cours...</p>
          </>
        )}

        {status === "success" && (
          <>
            <CheckCircle2 className="text-emerald-500 mx-auto mb-4" size={36} />
            <h1 className="text-lg font-bold text-gray-800 mb-1">Adresse confirmée !</h1>
            <p className="text-sm text-gray-500">Redirection vers votre espace...</p>
          </>
        )}

        {status === "error" && (
          <>
            <XCircle className="text-red-500 mx-auto mb-4" size={36} />
            <h1 className="text-lg font-bold text-gray-800 mb-1">Lien invalide</h1>
            <p className="text-sm text-gray-500 mb-6">{error}</p>
            <Link to="/verification-en-attente" className="text-teal-600 font-semibold hover:underline text-sm">
              Redemander un courriel
            </Link>
          </>
        )}
      </div>
    </div>
  );
}