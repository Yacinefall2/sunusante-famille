import { useState } from "react";
import { Heart } from "lucide-react";
import toast from "react-hot-toast";
import { Input } from "../ui/Input";
import { Button } from "../ui/Button";
import { useAuth } from "../../context/AuthContext";

// Écran « Créer votre compte SunuSanté Famille avec Google » : affiché quand
// personne n'a encore de compte avec cette identité Google. Le compte n'est
// créé qu'ici, après confirmation (nom modifiable, adresse Google non
// modifiable, conditions acceptées). `pending` : { signupToken, name, email }
// renvoyés par le serveur. `onDone(data)` reçoit le compte créé (et, depuis une
// invitation, le résultat de son acceptation dans data.invitation).
export function GoogleSignupConfirm({ pending, onDone, onCancel, subtitle }) {
  const { googleSignup } = useAuth();
  const [name, setName] = useState(pending.name ?? "");
  const [accepted, setAccepted] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      const data = await googleSignup({ signupToken: pending.signupToken, name: name.trim() });
      await onDone(data);
    } catch (err) {
      toast.error(err.message);
      setSubmitting(false);
    }
  };

  return (
    <div>
      <div className="flex flex-col items-center mb-5">
        <div className="w-12 h-12 bg-gradient-to-br from-teal-500 to-blue-600 rounded-xl flex items-center justify-center shadow-md mb-3">
          <Heart size={22} className="text-white" />
        </div>
        <h1 className="text-lg font-bold text-gray-800 text-center">Créer votre compte SunuSanté Famille avec Google</h1>
        {subtitle && <p className="text-sm text-gray-500 text-center mt-1">{subtitle}</p>}
      </div>
      <form onSubmit={submit} className="space-y-4">
        <Input label="Nom complet" required maxLength={150} value={name} onChange={(e) => setName(e.target.value)} />
        <Input label="Adresse courriel (celle de votre compte Google)" value={pending.email} disabled />
        <p className="text-xs text-gray-600 bg-gray-50 rounded-xl p-3">
          SunuSanté Famille garde les informations de santé de votre famille : des données sensibles, visibles seulement
          des personnes à qui votre famille donne accès. De Google, nous ne conservons que votre nom, votre adresse et
          l&apos;identifiant de votre compte Google.
        </p>
        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            required
            className="mt-1 w-4 h-4"
            checked={accepted}
            onChange={(e) => setAccepted(e.target.checked)}
          />
          <span className="text-sm text-gray-700">
            J&apos;accepte les conditions d&apos;utilisation et la politique de confidentialité de SunuSanté Famille : mes
            données servent uniquement au suivi de santé de ma famille, ne sont jamais vendues ni partagées sans mon
            accord, et je peux supprimer mon compte à tout moment depuis « Mon compte ».
          </span>
        </label>
        <Button type="submit" loading={submitting} disabled={!accepted || !name.trim()} className="w-full">
          Créer mon compte
        </Button>
        <button type="button" onClick={onCancel} className="w-full text-sm text-gray-500 hover:text-teal-600 hover:underline">
          Annuler
        </button>
      </form>
    </div>
  );
}
