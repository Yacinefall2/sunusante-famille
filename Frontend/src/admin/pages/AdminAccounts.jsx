import { useState } from "react";
import { Link } from "react-router-dom";
import { Search } from "lucide-react";
import { adminFetch } from "../api";
import { Card } from "../AdminLayout";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Input } from "../../components/ui/Input";
import { formatDateTime } from "../../lib/utils";

// Recherche de comptes par adresse ou par nom (recherche tracée au journal d'audit).
export default function AdminAccountsPage() {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const search = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      setRows(await adminFetch(`/api/admin/accounts?q=${encodeURIComponent(q.trim())}`));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">Comptes</h1>
      <Card>
        <form onSubmit={search} className="flex flex-col sm:flex-row gap-3 sm:items-end">
          <div className="flex-1">
            <Input label="Adresse courriel ou nom (2 caractères minimum)" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <Button type="submit" loading={loading} disabled={q.trim().length < 2} className="bg-slate-800 hover:bg-slate-900">
            <Search size={15} /> Rechercher
          </Button>
        </form>
      </Card>
      {error && <p className="text-red-600">{error}</p>}
      {rows &&
        (rows.length === 0 ? (
          <p className="text-slate-500">Aucun compte trouvé.</p>
        ) : (
          <div className="bg-white rounded-xl border border-slate-200 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-100 text-left text-slate-600">
                <tr>
                  <th className="px-3 py-2">Nom</th>
                  <th className="px-3 py-2">Adresse</th>
                  <th className="px-3 py-2">Créé le</th>
                  <th className="px-3 py-2">Dernière connexion</th>
                  <th className="px-3 py-2">État</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((u) => (
                  <tr key={u.id}>
                    <td className="px-3 py-2">
                      <Link to={`/admin/comptes/${u.id}`} className="underline font-semibold">
                        {u.name}
                      </Link>
                    </td>
                    <td className="px-3 py-2">{u.email}</td>
                    <td className="px-3 py-2">{formatDateTime(u.createdAt)}</td>
                    <td className="px-3 py-2">{u.lastLoginAt ? formatDateTime(u.lastLoginAt) : "—"}</td>
                    <td className="px-3 py-2 space-x-1">
                      {u.suspended && <Badge variant="danger">Suspendu</Badge>}
                      {!u.emailVerified && <Badge variant="warning">Adresse non vérifiée</Badge>}
                      {!u.suspended && u.emailVerified && <Badge variant="success">Actif</Badge>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
    </div>
  );
}
