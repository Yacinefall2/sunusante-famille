import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Input } from "../components/ui/Input";
import { Button } from "../components/ui/Button";
import { KeyRound, CheckCircle2, XCircle } from "lucide-react";
import toast from "react-hot-toast";

const MIN_LENGTH = 8;

// Choix d'un nouveau mot de passe depuis le lien reçu par courriel.
export default function ResetPasswordPage() {
  const { token } = useParams();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("form"); // form | done | invalid
  const [error, setError] = useState("");

  const tooShort = password.length > 0 && password.length < MIN_LENGTH;
  const mismatch = confirm.length > 0 && confirm !== password;

  const submit = async (e) => {
    e.preventDefault();
    if (password.length < MIN_LENGTH || password !== confirm) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/auth/reset-password/${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        setStatus("done");
        return;
      }
      const err = await res.json().catch(() => ({}));
      if (res.status === 400) {
        toast.error(err.error || "Mot de passe invalide");
      } else {
        setError(err.error || "Lien de réinitialisation invalide");
        setStatus("invalid");
      }
    } catch {
      toast.error("Échec de l'enregistrement");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="w-full max-w-sm bg-white rounded-2xl shadow-xl p-8">
        {status === "done" ? (
          <div className="text-center">
            <CheckCircle2 className="text-emerald-500 mx-auto mb-4" size={36} />
            <h1 className="text-lg font-bold text-gray-800 mb-1">Mot de passe modifié</h1>
            <p className="text-sm text-gray-500 mb-6">
              Pour votre sécurité, vous avez été déconnecté(e) de tous vos appareils. Connectez-vous avec votre nouveau
              mot de passe.
            </p>
            <Link to="/login" className="inline-block">
              <Button>Se connecter</Button>
            </Link>
          </div>
        ) : status === "invalid" ? (
          <div className="text-center">
            <XCircle className="text-red-500 mx-auto mb-4" size={36} />
            <h1 className="text-lg font-bold text-gray-800 mb-1">Lien invalide</h1>
            <p className="text-sm text-gray-500 mb-6">{error}</p>
            <Link to="/mot-de-passe-oublie" className="text-teal-600 font-semibold hover:underline text-sm">
              Faire une nouvelle demande
            </Link>
          </div>
        ) : (
          <>
            <div className="flex flex-col items-center mb-6">
              <div className="w-12 h-12 bg-gradient-to-br from-teal-500 to-blue-600 rounded-xl flex items-center justify-center shadow-md mb-3">
                <KeyRound size={22} className="text-white" />
              </div>
              <h1 className="text-xl font-bold text-gray-800">Nouveau mot de passe</h1>
            </div>
            <form onSubmit={submit} className="space-y-4">
              <Input
                label="Nouveau mot de passe"
                type="password"
                autoComplete="new-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                error={tooShort ? `${MIN_LENGTH} caractères minimum` : undefined}
              />
              <Input
                label="Confirmer le mot de passe"
                type="password"
                autoComplete="new-password"
                required
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="••••••••"
                error={mismatch ? "Les deux mots de passe ne correspondent pas" : undefined}
              />
              <Button
                type="submit"
                loading={loading}
                disabled={password.length < MIN_LENGTH || password !== confirm}
                className="w-full"
              >
                Enregistrer
              </Button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
