import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { Input } from "../components/ui/Input";
import { Button } from "../components/ui/Button";
import { Heart } from "lucide-react";
import toast from "react-hot-toast";

// Retour après connexion (?next=/export/…) : seulement un chemin interne à
// l'application, jamais une adresse extérieure (« //site » ou « https:… »).
const safeNext = (value) => (typeof value === "string" && /^\/(?![/\\])/.test(value) ? value : null);

export default function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const next = safeNext(searchParams.get("next"));
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  // Compte suspendu par le support (UC-52) : message détaillé (durée, motif,
  // recours) affiché en clair, révélé seulement après un mot de passe correct.
  const [suspended, setSuspended] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setSuspended(null);
    try {
      const data = await login(email, password);
      navigate(data.emailVerified ? next ?? "/dashboard" : "/verification-en-attente");
    } catch (err) {
      if (err.code === "ACCOUNT_SUSPENDED") setSuspended(err.message);
      else toast.error(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="w-full max-w-sm bg-white rounded-2xl shadow-xl p-8">
        <div className="flex flex-col items-center mb-6">
          <div className="w-12 h-12 bg-gradient-to-br from-teal-500 to-blue-600 rounded-xl flex items-center justify-center shadow-md mb-3">
            <Heart size={22} className="text-white" />
          </div>
          <h1 className="text-xl font-bold text-gray-800">Connexion à SunuSanté Famille</h1>
        </div>
        {suspended && (
          <div role="alert" className="mb-4 text-sm bg-red-50 border border-red-200 text-red-800 rounded-xl p-3">
            {suspended}
          </div>
        )}
        <form onSubmit={submit} className="space-y-4">
          <Input
            label="Adresse courriel"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="vous@exemple.com"
          />
          <Input
            label="Mot de passe"
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
          />
          <div className="-mt-2 text-right">
            <Link to="/mot-de-passe-oublie" className="text-xs font-semibold text-teal-600 hover:underline">
              Mot de passe oublié ?
            </Link>
          </div>
          <Button type="submit" loading={loading} className="w-full">
            Se connecter
          </Button>
        </form>
        <p className="text-sm text-center mt-4">
          <Link to="/support/acces" className="text-gray-500 hover:text-teal-600 hover:underline">
            Je n'arrive plus à accéder à mon compte
          </Link>
        </p>
        <p className="text-sm text-gray-500 text-center mt-4">
          Pas encore de compte ?{" "}
          <Link to="/register" className="text-teal-600 font-semibold hover:underline">
            Créer un compte
          </Link>
        </p>
      </div>
    </div>
  );
}