import { useEffect, useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { Input } from "../components/ui/Input";
import { Button } from "../components/ui/Button";
import { Heart, Loader2 } from "lucide-react";
import toast from "react-hot-toast";

const ROLE_LABELS = {
  parent: "Parent",
  adult: "Membre adulte",
  dependent: "Personne dépendante",
};

const DOCUMENT_ROLE_LABELS = {
  titulaire: "Titulaire",
  gestionnaire: "Gestionnaire",
  relais: "Relais",
  lecteur_invite: "Lecteur invité",
};

export default function AcceptInvitationPage() {
  const { token } = useParams();
  const navigate = useNavigate();
  const { user, login, register, logout, refreshUser } = useAuth();

  const [invitation, setInvitation] = useState(null);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState("login"); // "login" | "register"
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetch(`/api/invitations/${token}`)
      .then((res) => {
        if (!res.ok) throw new Error("not found");
        return res.json();
      })
      .then(setInvitation)
      .catch(() => setInvitation({ error: true }))
      .finally(() => setLoading(false));
  }, [token]);

  const accept = async () => {
    setSubmitting(true);
    try {
      const res = await fetch(`/api/invitations/${token}/accept`, { method: "POST" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Échec de l'acceptation");
      }
      // L'acceptation vient de vérifier l'adresse côté serveur au passage —
      // on rafraîchit l'utilisateur en contexte pour que emailVerified soit
      // à jour, sinon ProtectedRoute nous renverrait vers l'écran d'attente.
      await refreshUser();
      toast.success("Invitation acceptée !");
      navigate("/dashboard");
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const submitAuth = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      if (mode === "login") {
        await login(invitation.email, password);
      } else {
        if (password.length < 8) {
          toast.error("Le mot de passe doit contenir au moins 8 caractères");
          setSubmitting(false);
          return;
        }
        // L'inscription ne connecte plus automatiquement (compte non vérifié
        // par défaut) — on se connecte donc juste après. C'est l'acceptation
        // de l'invitation elle-même qui vérifiera l'adresse (voir accept()).
        await register(name, invitation.email, password);
        await login(invitation.email, password);
      }
      await accept();
    } catch (err) {
      toast.error(err.message);
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <Loader2 className="animate-spin text-teal-600" size={40} />
      </div>
    );
  }

  if (invitation?.error || !invitation) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <div className="w-full max-w-sm bg-white rounded-2xl shadow-xl p-8 text-center">
          <h1 className="text-lg font-bold text-gray-800 mb-2">Invitation introuvable</h1>
          <p className="text-sm text-gray-500 mb-4">Ce lien n&apos;est plus valide.</p>
          <Link to="/login" className="text-teal-600 font-semibold hover:underline text-sm">
            Retour à la connexion
          </Link>
        </div>
      </div>
    );
  }

  if (invitation.accepted) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <div className="w-full max-w-sm bg-white rounded-2xl shadow-xl p-8 text-center">
          <h1 className="text-lg font-bold text-gray-800 mb-2">Invitation déjà utilisée</h1>
          <Link to="/login" className="text-teal-600 font-semibold hover:underline text-sm">
            Se connecter
          </Link>
        </div>
      </div>
    );
  }

  if (invitation.expired) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <div className="w-full max-w-sm bg-white rounded-2xl shadow-xl p-8 text-center">
          <h1 className="text-lg font-bold text-gray-800 mb-2">Invitation expirée</h1>
          <p className="text-sm text-gray-500">
            Demandez à un parent de la famille de vous inviter à nouveau.
          </p>
        </div>
      </div>
    );
  }

  const roleLabel = ROLE_LABELS[invitation.role] || invitation.role;

  // Déjà connecté avec le bon compte
  if (user && user.email?.toLowerCase() === invitation.email?.toLowerCase()) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <div className="w-full max-w-sm bg-white rounded-2xl shadow-xl p-8 text-center">
          <div className="w-12 h-12 bg-gradient-to-br from-teal-500 to-blue-600 rounded-xl flex items-center justify-center shadow-md mb-3 mx-auto">
            <Heart size={22} className="text-white" />
          </div>
          <h1 className="text-lg font-bold text-gray-800 mb-2">Rejoindre {invitation.familyName}</h1>
          <p className="text-sm text-gray-500 mb-6">
            Vous avez été invité(e) en tant que <strong>{roleLabel}</strong>.
            {invitation.documentMemberId && invitation.documentRole && (
              <>
                {" "}Vous serez <strong>{DOCUMENT_ROLE_LABELS[invitation.documentRole] ?? invitation.documentRole}</strong> du
                dossier de <strong>{invitation.documentMemberName}</strong>.
              </>
            )}
          </p>
          <Button onClick={accept} loading={submitting} className="w-full">
            Accepter l&apos;invitation
          </Button>
        </div>
      </div>
    );
  }

  // Connecté avec un AUTRE compte que celui invité
  if (user) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <div className="w-full max-w-sm bg-white rounded-2xl shadow-xl p-8 text-center">
          <h1 className="text-lg font-bold text-gray-800 mb-2">Compte différent</h1>
          <p className="text-sm text-gray-500 mb-6">
            Cette invitation est destinée à <strong>{invitation.email}</strong>, mais vous êtes connecté(e) avec un
            autre compte. Déconnectez-vous pour l&apos;accepter.
          </p>
          <Button variant="outline" onClick={() => logout()} className="w-full">
            Se déconnecter
          </Button>
        </div>
      </div>
    );
  }

  // Pas connecté : formulaire connexion/inscription, email verrouillé sur l'invitation
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="w-full max-w-sm bg-white rounded-2xl shadow-xl p-8">
        <div className="flex flex-col items-center mb-6">
          <div className="w-12 h-12 bg-gradient-to-br from-teal-500 to-blue-600 rounded-xl flex items-center justify-center shadow-md mb-3">
            <Heart size={22} className="text-white" />
          </div>
          <h1 className="text-lg font-bold text-gray-800 text-center">Rejoindre {invitation.familyName}</h1>
          <p className="text-sm text-gray-500 text-center mt-1">
            Invitation reçue en tant que <strong>{roleLabel}</strong>
            {invitation.documentMemberId && invitation.documentRole && (
              <>
                {" "}· {DOCUMENT_ROLE_LABELS[invitation.documentRole] ?? invitation.documentRole} du dossier de{" "}
                {invitation.documentMemberName}
              </>
            )}
          </p>
        </div>

        <div className="flex gap-2 mb-4">
          <button
            type="button"
            onClick={() => setMode("login")}
            className={`flex-1 py-2 rounded-xl text-sm font-medium transition-colors ${
              mode === "login" ? "bg-teal-600 text-white" : "bg-gray-100 text-gray-600"
            }`}
          >
            J&apos;ai déjà un compte
          </button>
          <button
            type="button"
            onClick={() => setMode("register")}
            className={`flex-1 py-2 rounded-xl text-sm font-medium transition-colors ${
              mode === "register" ? "bg-teal-600 text-white" : "bg-gray-100 text-gray-600"
            }`}
          >
            Créer un compte
          </button>
        </div>

        <form onSubmit={submitAuth} className="space-y-4">
          {mode === "register" && (
            <Input
              label="Nom complet"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Marie Dupont"
            />
          )}
          <Input label="Email" value={invitation.email} disabled />
          <Input
            label="Mot de passe"
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={mode === "register" ? "8 caractères minimum" : "••••••••"}
          />
          <Button type="submit" loading={submitting} className="w-full">
            {mode === "login" ? "Se connecter et rejoindre" : "Créer mon compte et rejoindre"}
          </Button>
        </form>
      </div>
    </div>
  );
}