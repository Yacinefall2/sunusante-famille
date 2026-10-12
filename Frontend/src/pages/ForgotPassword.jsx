import { useState } from "react";
import { Link } from "react-router-dom";
import { Input } from "../components/ui/Input";
import { Button } from "../components/ui/Button";
import { KeyRound, MailCheck } from "lucide-react";
import toast from "react-hot-toast";

// « Mot de passe oublié » : demande d'un lien de réinitialisation par courriel.
// Le serveur répond de la même façon que l'adresse ait un compte ou non.
export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      const res = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (res.ok) {
        setSent(true);
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || "Échec de l'envoi");
      }
    } catch {
      toast.error("Échec de l'envoi");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="w-full max-w-sm bg-white rounded-2xl shadow-xl p-8">
        {sent ? (
          <div className="text-center">
            <div className="w-12 h-12 bg-emerald-50 rounded-xl flex items-center justify-center mx-auto mb-3">
              <MailCheck size={22} className="text-emerald-600" />
            </div>
            <h1 className="text-lg font-bold text-gray-800 mb-2">Vérifiez vos courriels</h1>
            <p className="text-sm text-gray-600">
              Si un compte existe pour <strong className="break-all">{email.trim()}</strong>, un lien pour choisir un
              nouveau mot de passe vient d'y être envoyé. Il est valable 1 heure.
            </p>
            <p className="text-xs text-gray-400 mt-3">Pensez à regarder dans les courriels indésirables.</p>
            <Link to="/login" className="inline-block mt-6 text-teal-600 font-semibold hover:underline text-sm">
              ← Retour à la connexion
            </Link>
          </div>
        ) : (
          <>
            <div className="flex flex-col items-center mb-6 text-center">
              <div className="w-12 h-12 bg-gradient-to-br from-teal-500 to-blue-600 rounded-xl flex items-center justify-center shadow-md mb-3">
                <KeyRound size={22} className="text-white" />
              </div>
              <h1 className="text-xl font-bold text-gray-800">Mot de passe oublié</h1>
              <p className="text-sm text-gray-500 mt-1">
                Indiquez l'adresse de votre compte : nous vous enverrons un lien pour en choisir un nouveau.
              </p>
            </div>
            <form onSubmit={submit} className="space-y-4">
              <Input
                label="Email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="vous@exemple.com"
              />
              <Button type="submit" loading={loading} className="w-full">
                Envoyer le lien
              </Button>
            </form>
            <p className="text-sm text-gray-500 text-center mt-6">
              <Link to="/login" className="text-teal-600 font-semibold hover:underline">
                ← Retour à la connexion
              </Link>
            </p>
          </>
        )}
      </div>
    </div>
  );
}
