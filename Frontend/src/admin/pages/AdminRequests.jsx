import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { adminFetch, STATUS_LABELS, STATUS_VARIANTS, TYPE_LABELS } from "../api";
import { Card } from "../AdminLayout";
import { Badge } from "../../components/ui/Badge";
import { Select } from "../../components/ui/Input";
import { formatDateTime } from "../../lib/utils";

// Liste des demandes, filtrable par type et par statut.
export default function AdminRequestsPage() {
  const [params, setParams] = useSearchParams();
  const type = params.get("type") ?? "";
  const status = params.get("status") ?? "pending";
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    setRows(null);
    const q = new URLSearchParams();
    if (type) q.set("type", type);
    if (status !== "all") q.set("status", status);
    adminFetch(`/api/admin/requests?${q}`).then(setRows).catch((e) => setError(e.message));
  }, [type, status]);

  const setFilter = (key, value) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next);
  };

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">Demandes</h1>
      <Card>
        <div className="flex flex-wrap gap-3">
          <Select label="Type" value={type} onChange={(e) => setFilter("type", e.target.value)} className="!py-1.5">
            <option value="">Tous les types</option>
            {Object.entries(TYPE_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
          <Select label="Statut" value={status} onChange={(e) => setFilter("status", e.target.value)} className="!py-1.5">
            <option value="pending">À traiter (non vérifiées, ouvertes, en cours)</option>
            <option value="all">Tous les statuts</option>
            {Object.entries(STATUS_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
        </div>
      </Card>
      {error && <p className="text-red-600">{error}</p>}
      {!rows ? (
        <Loader2 className="animate-spin text-slate-500 mx-auto" size={28} />
      ) : rows.length === 0 ? (
        <p className="text-slate-500">Aucune demande.</p>
      ) : (
        <div className="bg-white rounded-xl border border-slate-200 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-100 text-left text-slate-600">
              <tr>
                <th className="px-3 py-2">Référence</th>
                <th className="px-3 py-2">Type</th>
                <th className="px-3 py-2">Statut</th>
                <th className="px-3 py-2">Compte concerné</th>
                <th className="px-3 py-2">Créée le</th>
                <th className="px-3 py-2">Prise en charge</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((r) => (
                <tr key={r.id} className="hover:bg-slate-50">
                  <td className="px-3 py-2">
                    <Link to={`/admin/demandes/${r.id}`} className="font-semibold underline">
                      {r.reference}
                    </Link>
                  </td>
                  <td className="px-3 py-2">{TYPE_LABELS[r.type] ?? r.type}</td>
                  <td className="px-3 py-2">
                    <Badge variant={STATUS_VARIANTS[r.status]}>{STATUS_LABELS[r.status] ?? r.status}</Badge>
                  </td>
                  <td className="px-3 py-2">
                    {r.accountEmail ?? "—"}
                    {!r.userId && <span className="text-xs text-slate-400"> (aucun compte)</span>}
                  </td>
                  <td className="px-3 py-2">{formatDateTime(r.createdAt)}</td>
                  <td className="px-3 py-2">{r.assignedToName ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
