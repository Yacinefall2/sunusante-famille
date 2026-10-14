import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Loader2, Activity, AlertTriangle, MailWarning, UserX } from "lucide-react";
import { adminFetch, TYPE_LABELS } from "../api";
import { Card } from "../AdminLayout";
import { Badge } from "../../components/ui/Badge";
import { formatDateTime, formatRelative } from "../../lib/utils";

// Accueil du support : demandes en attente par type, comptes suspendus,
// santé du worker, erreurs et courriels échoués des dernières 24 h.
export default function AdminHomePage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    adminFetch("/api/admin/dashboard").then(setData).catch((e) => setError(e.message));
  }, []);

  if (error) return <p className="text-red-600">{error}</p>;
  if (!data) return <Loader2 className="animate-spin text-slate-500 mx-auto" size={32} />;

  // Worker « vivant » : un passage il y a moins de 3 minutes.
  const workerAge = data.worker ? Date.now() - new Date(data.worker.occurredAt).getTime() : null;
  const workerOk = workerAge !== null && workerAge < 3 * 60 * 1000;

  return (
    <div className="space-y-5">
      <h1 className="text-xl font-bold">Accueil</h1>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Object.entries(data.requestsByType).map(([type, counts]) => (
          <Link key={type} to={`/admin/demandes?type=${type}&status=pending`} className="block">
            <Card className="hover:border-slate-400 h-full">
              <p className="text-sm text-slate-500">{TYPE_LABELS[type]}</p>
              <p className="text-3xl font-bold mt-1">{counts.open + counts.in_progress}</p>
              <p className="text-xs text-slate-500 mt-1">
                {counts.open} ouverte(s) · {counts.in_progress} en cours · {counts.unverified} non vérifiée(s)
              </p>
            </Card>
          </Link>
        ))}
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card title="Worker (rappels)">
          <div className="flex items-center gap-2">
            <Activity size={18} className={workerOk ? "text-emerald-600" : "text-red-600"} />
            <Badge variant={workerOk ? "success" : "danger"}>{workerOk ? "Actif" : "Aucun passage récent"}</Badge>
          </div>
          <p className="text-sm text-slate-600 mt-2">
            Dernier battement : {data.worker ? `${formatDateTime(data.worker.occurredAt)} (${formatRelative(data.worker.occurredAt)})` : "jamais"}
          </p>
          {data.worker?.metadata && (
            <p className="text-xs text-slate-500 mt-1">
              Durée {data.worker.metadata.durationMs ?? "?"} ms · {data.worker.metadata.reminders ?? 0} rappel(s) · {data.worker.metadata.errors ?? 0} erreur(s)
            </p>
          )}
        </Card>
        <Card title="Erreurs (24 h)">
          <div className="flex items-center gap-2">
            <AlertTriangle size={18} className={data.errorsLast24h ? "text-red-600" : "text-slate-400"} />
            <span className="text-2xl font-bold">{data.errorsLast24h}</span>
          </div>
          <Link to="/admin/journaux?level=error" className="text-sm text-slate-600 underline mt-2 inline-block">
            Voir les journaux
          </Link>
        </Card>
        <Card title="Courriels échoués (24 h)">
          <div className="flex items-center gap-2">
            <MailWarning size={18} className={data.emailFailuresLast24h ? "text-red-600" : "text-slate-400"} />
            <span className="text-2xl font-bold">{data.emailFailuresLast24h}</span>
          </div>
          <Link to="/admin/journaux?category=email&level=error" className="text-sm text-slate-600 underline mt-2 inline-block">
            Voir les journaux
          </Link>
        </Card>
      </div>

      <Card title={`Comptes suspendus (${data.suspendedAccounts.length})`}>
        {data.suspendedAccounts.length === 0 ? (
          <p className="text-sm text-slate-500">Aucun compte suspendu.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {data.suspendedAccounts.map((u) => (
              <li key={u.id} className="py-2 flex items-center gap-3 text-sm">
                <UserX size={16} className="text-red-500" />
                <Link to={`/admin/comptes/${u.id}`} className="font-semibold underline">
                  {u.name}
                </Link>
                <span className="text-slate-500">{u.email}</span>
                <span className="ml-auto text-slate-500">
                  depuis le {formatDateTime(u.suspendedAt)} · {u.suspendedUntil ? `jusqu'au ${formatDateTime(u.suspendedUntil)}` : "jusqu'à nouvel ordre"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
