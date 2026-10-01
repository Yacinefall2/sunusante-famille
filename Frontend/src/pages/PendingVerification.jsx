import { useState } from "react";
import { useLocation, Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { Button } from "../components/ui/Button";
import { MailCheck } from "lucide-react";
import toast from "react-hot-toast";

// Écran "compte en attente de vérification" (§13, écran 7). Une seule
// action possible : renvoyer le courriel. On y arrive soit juste après
// l'inscription (email transmis via l'état de navigation), soit en s'y
// rendant directement (l'utilisateur retape alors son adresse).
export default function PendingVerificationPage() {
  const { resendVerification } = useAuth();
  const location = useLocation();
  const [email, setEmail] = useState(location.state?.email ?? "");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  const resend = async () => {
    if (!email.trim()) {
      toast.error("Indiquez votre adresse courriel");
      return;
    }
    setSending(true);
    try {
      await resendVerification(email.trim());
      setSent(true);
      toast.success("Courriel envoyé, si un compte existe avec cette adresse.");
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="w-full max-w-sm bg-white rounded-2xl shadow-xl p-8 text-center">
        <div className="w-14 h-14 bg-teal-50 rounded-2xl flex items-center justify-center mx-auto mb-4">
          <MailCheck size={28} className="text-teal-600" />
        </div>
        <h1 className="text-xl font-bold text-gray-800 mb-2">Vérifiez votre boîte de réception</h1>
        <p className="text-sm text-gray-500 mb-6">
          {location.state?.email ? (
            <>
              Un courriel a été envoyé à <strong>{location.state.email}</strong>. Cliquez sur le bouton
              "Accéder à mon compte" qu'il contient pour activer votre compte.
            </>
          ) : (
            "Confirmez votre adresse courriel pour activer votre compte et accéder à votre espace familial."
          )}
        </p>

        {!location.state?.email && (
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="vous@exemple.com"
            className="w-full px-4 py-2.5 rounded-xl border border-gray-200 bg-gray-50 text-gray-800 placeholder-gray-400 mb-4 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-teal-500 focus:bg-white"
          />
        )}

        <Button onClick={resend} loading={sending} className="w-full">
          {sent ? "Renvoyer à nouveau" : "Renvoyer le courriel"}
        </Button>

        <p className="text-sm text-gray-500 mt-6">
          Déjà vérifié ?{" "}
          <Link to="/login" className="text-teal-600 font-semibold hover:underline">
            Se connecter
          </Link>
        </p>
      </div>
    </div>
  );
}