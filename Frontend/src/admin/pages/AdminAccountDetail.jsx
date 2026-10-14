import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, Loader2, ShieldCheck } from "lucide-react";
import toast from "react-hot-toast";
import { adminFetch } from "../api";
import { Card } from "../AdminLayout";
import { AccountMeta } from "../AccountMeta";
import { Button } from "../../components/ui/Button";
import { Textarea } from "../../components/ui/Input";

// Fiche d'un compte (métadonnées seulement — consultation tracée au journal
// d'audit) et levée manuelle d'une suspension.
export default function AdminAccountDetailPage() {
  const { id } = useParams();
  const [account, setAccount] = useState(null);
  const [error, setError] = useState(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    adminFetch(`/api/admin/accounts/${id}`).then(setAccount).catch((e) => setError(e.message));
  }, [id]);

  const unsuspend = async () => {
    setBusy(true);
    try {
      setAccount(await adminFetch(`/api/admin/accounts/${id}/unsuspend`, { method: "POST", body: { reason } }));
      setReason("");
      toast.success("Suspension levée — la personne et l'administrateur familial sont prévenus");
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (error) return <p className="text-red-600">{error}</p>;
  if (!account) return <Loader2 className="animate-spin text-slate-500 mx-auto" size={32} />;

  return (
    <div className="space-y-4">
      <Link to="/admin/comptes" className="text-sm text-slate-600 inline-flex items-center gap-1 underline">
        <ArrowLeft size={14} /> Recherche de comptes
      </Link>
      <h1 className="text-xl font-bold">{account.name}</h1>
      <Card title="Métadonnées du compte">
        <AccountMeta account={account} />
        <p className="text-xs text-slate-500 mt-3">
          Cloisonnement : le support n'a accès à aucun dossier médical, document, rendez-vous, traitement ni journal de la famille.
        </p>
      </Card>
      {account.suspension && (
        <Card title="Lever la suspension">
          <Textarea label="Motif (obligatoire, tracé au journal d'audit)" value={reason} onChange={(e) => setReason(e.target.value)} />
          <Button className="mt-3" size="sm" loading={busy} disabled={reason.trim().length < 5} onClick={unsuspend}>
            <ShieldCheck size={14} /> Lever la suspension
          </Button>
        </Card>
      )}
    </div>
  );
}
