import { useState } from "react";
import { Link } from "react-router-dom";
import { LifeBuoy, MailCheck, ShieldAlert } from "lucide-react";
import toast from "react-hot-toast";
import { Input, Textarea } from "../components/ui/Input";
import { Button } from "../components/ui/Button";

// « Je n'arrive plus à accéder à mon compte » (UC-50) — page publique.
// La réponse est la même que l'adresse corresponde à un compte ou non. Si le
// compte existe, un lien de confirmation part à SON adresse : la demande est
// alors « vérifiée » et transmise au support.
export default function SupportAccessPage() {
  const [form, setForm] = useState({ email: "", description: "", newEmail: "" });
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      const res = await fetch("/api/support/public/access-request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, newEmail: form.newEmail.trim() || undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Échec de l'envoi");
      setSent(data.message);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-xl p-8">
        {sent ? (
          <div className="text-center space-y-3">
            <MailCheck size={36} className="text-teal-600 mx-auto" />
            <h1 className="text-xl font-bold text-gray-800">Demande envoyée</h1>
            <p className="text-sm text-gray-600">{sent}</p>
            <p className="text-sm text-gray-600">
              Vous n'avez plus accès à cette boîte ? Le support vous contactera à la nouvelle adresse indiquée pour vérifier
              votre identité par un autre moyen.
            </p>
            <Link to="/login" className="text-teal-600 font-semibold hover:underline text-sm">
              Retour à la connexion
            </Link>
          </div>
        ) : (
          <>
            <div className="flex flex-col items-center mb-5">
              <div className="w-12 h-12 bg-gradient-to-br from-teal-500 to-blue-600 rounded-xl flex items-center justify-center shadow-md mb-3">
                <LifeBuoy size={22} className="text-white" />
              </div>
              <h1 className="text-xl font-bold text-gray-800 text-center">Je n'arrive plus à accéder à mon compte</h1>
              <p className="text-sm text-gray-500 text-center mt-1">
                Mot de passe oublié ? Essayez d'abord{" "}
                <Link to="/mot-de-passe-oublie" className="text-teal-600 font-semibold hover:underline">
                  « Mot de passe oublié »
                </Link>
                .
              </p>
            </div>
            <div className="flex gap-2 bg-amber-50 border border-amber-200 text-amber-900 rounded-xl p-3 text-sm mb-4">
              <ShieldAlert size={16} className="flex-shrink-0 mt-0.5" />
              <p>
                <strong>N'indiquez aucune information médicale.</strong> Le support n'a jamais accès aux dossiers de santé.
              </p>
            </div>
            <form onSubmit={submit} className="space-y-4">
              <Input
                label="Adresse courriel du compte"
                type="email"
                required
                value={form.email}
                onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                placeholder="vous@exemple.com"
              />
              <Textarea
                label="Que se passe-t-il ?"
                required
                minLength={10}
                maxLength={4000}
                rows={4}
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                placeholder="Ex. : je n'ai plus accès à mon ancienne adresse courriel et j'ai oublié mon mot de passe."
              />
              <Input
                label="Nouvelle adresse de contact (si vous avez perdu l'accès à l'ancienne boîte)"
                type="email"
                value={form.newEmail}
                onChange={(e) => setForm((f) => ({ ...f, newEmail: e.target.value }))}
                placeholder="facultatif"
              />
              <Button type="submit" loading={loading} className="w-full">
                Envoyer la demande au support
              </Button>
            </form>
            <p className="text-sm text-gray-500 text-center mt-5">
              <Link to="/login" className="text-teal-600 font-semibold hover:underline">
                Retour à la connexion
              </Link>
            </p>
          </>
        )}
      </div>
    </div>
  );
}
