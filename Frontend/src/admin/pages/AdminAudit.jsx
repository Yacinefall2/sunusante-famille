import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { adminFetch } from "../api";
import { Card } from "../AdminLayout";
import { Button } from "../../components/ui/Button";
import { Select } from "../../components/ui/Input";
import { formatDateTime } from "../../lib/utils";

// Journal d'audit du support : chaque action d'un compte support (qui, quoi,
// sur quel compte, pour quelle demande, motif, adresse IP). Ineffaçable :
// la base refuse toute modification ou suppression.
export default function AdminAuditPage() {
  const [action, setAction] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    setData(null);
    const q = new URLSearchParams({ page: String(page) });
    if (action) q.set("action", action);
    adminFetch(`/api/admin/audit?${q}`).then(setData).catch((e) => setError(e.message));
  }, [action, page]);

  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">Journal d'audit du support</h1>
      <p className="text-sm text-slate-500">Lecture seule — ce journal ne peut être ni modifié ni effacé.</p>
      <Card>
        <Select
          label="Action"
          value={action}
          onChange={(e) => {
            setAction(e.target.value);
            setPage(1);
          }}
        >
          <option value="">Toutes les actions</option>
          {Object.entries(data?.actions ?? {}).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </Select>
      </Card>
      {error && <p className="text-red-600">{error}</p>}
      {!data ? (
        <Loader2 className="animate-spin text-slate-500 mx-auto" size={28} />
      ) : (
        <>
          <div className="bg-white rounded-xl border border-slate-200 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-100 text-left text-slate-600">
                <tr>
                  <th className="px-3 py-2">Date</th>
                  <th className="px-3 py-2">Compte support</th>
                  <th className="px-3 py-2">Action</th>
                  <th className="px-3 py-2">Cible</th>
                  <th className="px-3 py-2">Demande</th>
                  <th className="px-3 py-2">Motif</th>
                  <th className="px-3 py-2">Adresse IP</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 align-top">
                {data.items.map((e) => (
                  <tr key={e.id}>
                    <td className="px-3 py-2 whitespace-nowrap">{formatDateTime(e.occurredAt)}</td>
                    <td className="px-3 py-2">{e.supportEmail ?? "—"}</td>
                    <td className="px-3 py-2">{e.actionLabel}</td>
                    <td className="px-3 py-2">{e.targetEmail ?? "—"}</td>
                    <td className="px-3 py-2">{e.requestId ? `n° ${e.requestId}` : "—"}</td>
                    <td className="px-3 py-2 max-w-xs break-words">{e.reason ?? "—"}</td>
                    <td className="px-3 py-2">{e.ip ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center gap-3 justify-center">
            <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              Précédent
            </Button>
            <span className="text-sm text-slate-600">
              Page {page} / {pages}
            </span>
            <Button size="sm" variant="ghost" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
              Suivant
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
