import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { adminFetch, CATEGORY_LABELS, LEVEL_VARIANTS } from "../api";
import { Card } from "../AdminLayout";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Input, Select } from "../../components/ui/Input";
import { formatDateTime } from "../../lib/utils";

// Journaux techniques (UC-53) : métadonnées seulement, conservées 90 jours.
// Consultation tracée au journal d'audit.
const FILTERS = ["level", "category", "from", "to", "q", "page"];

export default function AdminLogsPage() {
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState(params.get("q") ?? "");

  useEffect(() => {
    setData(null);
    const q = new URLSearchParams();
    for (const key of FILTERS) {
      const value = params.get(key);
      if (!value) continue;
      // Période saisie en heure locale : convertie en date ISO pour l'API.
      q.set(key, key === "from" || key === "to" ? new Date(value).toISOString() : value);
    }
    adminFetch(`/api/admin/logs?${q}`).then(setData).catch((e) => setError(e.message));
  }, [params]);

  const setFilter = (key, value) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key !== "page") next.delete("page");
    setParams(next);
  };

  const page = Number(params.get("page") ?? 1);
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">Journaux techniques</h1>
      <p className="text-sm text-slate-500">
        Métadonnées techniques seulement (route, statut, durée, adresse IP tronquée, destinataire masqué) — jamais de contenu
        de requête ni de donnée médicale. Conservation : 90 jours.
      </p>
      <Card>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5 items-end">
          <Select label="Niveau" value={params.get("level") ?? ""} onChange={(e) => setFilter("level", e.target.value)}>
            <option value="">Tous</option>
            <option value="info">Info</option>
            <option value="warn">Avertissement</option>
            <option value="error">Erreur</option>
          </Select>
          <Select label="Catégorie" value={params.get("category") ?? ""} onChange={(e) => setFilter("category", e.target.value)}>
            <option value="">Toutes</option>
            {Object.entries(CATEGORY_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
          <Input label="Du" type="datetime-local" value={params.get("from") ?? ""} onChange={(e) => setFilter("from", e.target.value)} />
          <Input label="Au" type="datetime-local" value={params.get("to") ?? ""} onChange={(e) => setFilter("to", e.target.value)} />
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setFilter("q", search.trim());
            }}
            className="flex gap-2 items-end"
          >
            <div className="flex-1">
              <Input label="Recherche" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            <Button type="submit" size="sm" className="bg-slate-800 hover:bg-slate-900">
              OK
            </Button>
          </form>
        </div>
      </Card>
      {error && <p className="text-red-600">{error}</p>}
      {!data ? (
        <Loader2 className="animate-spin text-slate-500 mx-auto" size={28} />
      ) : (
        <>
          <p className="text-sm text-slate-500">{data.total} entrée(s)</p>
          <div className="bg-white rounded-xl border border-slate-200 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-100 text-left text-slate-600">
                <tr>
                  <th className="px-3 py-2">Date</th>
                  <th className="px-3 py-2">Niveau</th>
                  <th className="px-3 py-2">Catégorie</th>
                  <th className="px-3 py-2">Message</th>
                  <th className="px-3 py-2">Métadonnées</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 align-top">
                {data.items.map((l) => (
                  <tr key={l.id}>
                    <td className="px-3 py-2 whitespace-nowrap">{formatDateTime(l.occurredAt)}</td>
                    <td className="px-3 py-2">
                      <Badge variant={LEVEL_VARIANTS[l.level]}>{l.level}</Badge>
                    </td>
                    <td className="px-3 py-2">{CATEGORY_LABELS[l.category] ?? l.category}</td>
                    <td className="px-3 py-2">{l.message}</td>
                    <td className="px-3 py-2 text-xs text-slate-600">
                      {l.metadata
                        ? Object.entries(l.metadata).map(([k, v]) => (
                            <span key={k} className="inline-block mr-2">
                              <span className="text-slate-400">{k}</span> {String(v)}
                            </span>
                          ))
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center gap-3 justify-center">
            <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => setFilter("page", String(page - 1))}>
              Précédent
            </Button>
            <span className="text-sm text-slate-600">
              Page {page} / {pages}
            </span>
            <Button size="sm" variant="ghost" disabled={page >= pages} onClick={() => setFilter("page", String(page + 1))}>
              Suivant
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
