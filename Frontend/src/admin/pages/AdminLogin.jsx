import { useState } from "react";
import { LifeBuoy } from "lucide-react";
import { useAdminAuth } from "../AdminAuthContext";
import { SupportBanner } from "../AdminLayout";
import { Input } from "../../components/ui/Input";
import { Button } from "../../components/ui/Button";

// Connexion du support : mot de passe + code à 6 chiffres de l'application
// d'authentification (double facteur, obligatoire).
export default function AdminLoginPage() {
  const { login, expiredMessage } = useAdminAuth();
  const [form, setForm] = useState({ email: "", password: "", code: "" });
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await login(form);
    } catch (err) {
      setError(err.message);
      setForm((f) => ({ ...f, code: "" }));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50">
      <SupportBanner />
      <div className="flex items-center justify-center p-4 pt-16">
        <div className="w-full max-w-sm bg-white rounded-xl border border-slate-200 shadow-sm p-8">
          <div className="flex flex-col items-center mb-6">
            <div className="w-12 h-12 bg-slate-800 rounded-xl flex items-center justify-center mb-3">
              <LifeBuoy size={22} className="text-white" />
            </div>
            <h1 className="text-lg font-bold text-slate-800 text-center">SunuSanté Famille — Support</h1>
            <p className="text-xs text-slate-500 mt-1">Accès réservé aux comptes support</p>
          </div>
          {expiredMessage && (
            <p className="text-sm bg-amber-50 border border-amber-200 text-amber-800 rounded-lg px-3 py-2 mb-4">{expiredMessage}</p>
          )}
          <form onSubmit={submit} className="space-y-4">
            <Input
              label="Adresse courriel"
              type="email"
              autoComplete="username"
              required
              value={form.email}
              onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
            />
            <Input
              label="Mot de passe"
              type="password"
              autoComplete="current-password"
              required
              value={form.password}
              onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
            />
            <Input
              label="Code à 6 chiffres (application d'authentification)"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9 ]{6,7}"
              maxLength={7}
              required
              value={form.code}
              onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))}
            />
            {error && <p className="text-sm text-red-600">{error}</p>}
            <Button type="submit" loading={loading} className="w-full bg-slate-800 hover:bg-slate-900 focus:ring-slate-500">
              Se connecter
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
