import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Loader2, ArrowLeft, AlertTriangle, KeyRound, Unlock, Mail, Trash2, UserX, Send } from "lucide-react";
import toast from "react-hot-toast";
import { adminFetch, STATUS_LABELS, STATUS_VARIANTS, TYPE_LABELS } from "../api";
import { Card } from "../AdminLayout";
import { AccountMeta } from "../AccountMeta";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Input, Select, Textarea } from "../../components/ui/Input";
import { Modal } from "../../components/ui/Modal";
import { formatDateTime } from "../../lib/utils";

// Détail d'une demande : métadonnées du compte concerné, échanges, réponse,
// statut, et actions selon le type — chacune avec un motif obligatoire,
// tracée au journal d'audit.

function ReasonField({ value, onChange, label = "Motif (obligatoire, tracé au journal d'audit)", minLength = 5 }) {
  return <Textarea label={label} value={value} onChange={(e) => onChange(e.target.value)} placeholder={`${minLength} caractères minimum`} />;
}

function IdentityCheckbox({ checked, onChange }) {
  return (
    <label className="flex items-start gap-2 text-sm bg-amber-50 border border-amber-200 rounded-lg p-3">
      <input type="checkbox" className="mt-1" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <strong>Identité vérifiée hors application.</strong> J'ai vérifié par un autre moyen que cette personne est bien la
        titulaire du compte (appel au numéro connu, confirmation par l'administrateur familial, pièce d'identité en visio…).
      </span>
    </label>
  );
}

export default function AdminRequestDetailPage() {
  const { id } = useParams();
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [reply, setReply] = useState("");
  const [statusForm, setStatusForm] = useState({ status: "", reason: "", identityVerifiedOffline: false });
  const [reason, setReason] = useState("");
  const [emailForm, setEmailForm] = useState({ newEmail: "", reason: "", identityVerifiedOffline: false });
  const [suspendForm, setSuspendForm] = useState({ reason: "", until: "" });
  const [deletion, setDeletion] = useState(null); // { confirmEmail, reason, deleteMedicalRecord }

  const load = () =>
    adminFetch(`/api/admin/requests/${id}`)
      .then((d) => {
        setDetail(d);
        setEmailForm((f) => ({ ...f, newEmail: f.newEmail || d.request.newEmail || "" }));
      })
      .catch((e) => setError(e.message));

  useEffect(() => {
    load();
  }, [id]);

  const act = async (key, url, body, success) => {
    setBusy(key);
    try {
      const data = await adminFetch(url, { method: "POST", body });
      if (data?.request) setDetail(data);
      else await load();
      toast.success(success);
      return true;
    } catch (e) {
      toast.error(e.message);
      return false;
    } finally {
      setBusy(null);
    }
  };

  if (error) return <p className="text-red-600">{error}</p>;
  if (!detail) return <Loader2 className="animate-spin text-slate-500 mx-auto" size={32} />;
  const { request: r, messages, account, requester, family } = detail;
  const base = `/api/admin/requests/${r.id}`;
  const isOpen = r.status === "open" || r.status === "in_progress";
  const closed = r.status === "resolved" || r.status === "rejected";

  return (
    <div className="space-y-4">
      <Link to="/admin/demandes" className="text-sm text-slate-600 inline-flex items-center gap-1 underline">
        <ArrowLeft size={14} /> Toutes les demandes
      </Link>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-bold">{r.reference}</h1>
        <Badge variant="default">{TYPE_LABELS[r.type]}</Badge>
        <Badge variant={STATUS_VARIANTS[r.status]}>{STATUS_LABELS[r.status]}</Badge>
        {r.assignedToName ? (
          <span className="text-sm text-slate-500">Prise en charge par {r.assignedToName}</span>
        ) : (
          <Button size="sm" variant="outline" loading={busy === "assign"} onClick={() => act("assign", `${base}/assign`, undefined, "Demande prise en charge")}>
            Prendre en charge
          </Button>
        )}
      </div>

      {r.status === "unverified" && (
        <div className="flex gap-3 bg-amber-50 border border-amber-200 text-amber-900 rounded-xl p-4 text-sm">
          <AlertTriangle size={18} className="flex-shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold">Demande non vérifiée</p>
            <p>
              Le lien de confirmation envoyé à l'adresse du compte n'a pas été suivi. Si la personne n'a plus accès à cette
              boîte, vérifiez son identité <strong>hors application</strong> avant toute action : appel au numéro connu de la
              famille, confirmation par l'administrateur familial, pièce d'identité présentée en visio… Ne demandez jamais
              d'information médicale pour vérifier une identité.
            </p>
          </div>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Demande">
          <dl className="text-sm space-y-1.5">
            <p>
              <span className="text-slate-500">Créée le :</span> {formatDateTime(r.createdAt)}
            </p>
            <p>
              <span className="text-slate-500">Adresse du compte :</span> {r.accountEmail ?? "—"}
            </p>
            <p>
              <span className="text-slate-500">Adresse de contact :</span> {r.contactEmail}
            </p>
            {r.newEmail && (
              <p>
                <span className="text-slate-500">Nouvelle adresse proposée :</span> {r.newEmail}
              </p>
            )}
            {r.reportReasonLabel && (
              <p>
                <span className="text-slate-500">Motif du signalement :</span> {r.reportReasonLabel}
              </p>
            )}
            {requester && (
              <p>
                <span className="text-slate-500">Signalé par :</span> {requester.name} ({requester.email})
              </p>
            )}
            {family && (
              <p>
                <span className="text-slate-500">Famille :</span> {family.name}
              </p>
            )}
            {r.type === "data_deletion" && (
              <p>
                <span className="text-slate-500">Suppression de la fiche médicale demandée :</span>{" "}
                <strong>{r.deleteMedicalRecord ? "oui" : "non"}</strong>
              </p>
            )}
            <p>
              <span className="text-slate-500">Identité :</span>{" "}
              {r.verifiedAt ? `confirmée le ${formatDateTime(r.verifiedAt)}` : "non confirmée par lien"}
              {r.verifiedOfflineAt && ` · vérifiée hors application le ${formatDateTime(r.verifiedOfflineAt)}`}
            </p>
          </dl>
          <p className="text-sm whitespace-pre-wrap bg-slate-50 rounded-lg p-3 mt-3">{r.description}</p>
        </Card>
        <Card title="Compte concerné (métadonnées)">
          <AccountMeta account={account} showLink />
        </Card>
      </div>

      <Card title="Échanges">
        {messages.length === 0 ? (
          <p className="text-sm text-slate-500">Aucun échange pour l'instant.</p>
        ) : (
          <ul className="space-y-2 mb-4">
            {messages.map((m) => (
              <li key={m.id} className={`rounded-lg p-3 text-sm ${m.authorType === "support" ? "bg-slate-100" : "bg-teal-50"}`}>
                <p className="text-xs text-slate-500 mb-1">
                  {m.authorType === "support" ? `Support (${m.authorName})` : m.authorName ?? "Utilisateur"} — {formatDateTime(m.createdAt)}
                </p>
                <p className="whitespace-pre-wrap">{m.body}</p>
              </li>
            ))}
          </ul>
        )}
        <Textarea label="Répondre (courriel envoyé à l'adresse de contact)" value={reply} onChange={(e) => setReply(e.target.value)} />
        <p className="text-xs text-slate-500 mt-1">Ne demandez et n'écrivez jamais d'information médicale.</p>
        <Button
          className="mt-2"
          size="sm"
          loading={busy === "reply"}
          disabled={!reply.trim()}
          onClick={async () => (await act("reply", `${base}/reply`, { message: reply }, "Réponse envoyée")) && setReply("")}
        >
          <Send size={14} /> Envoyer la réponse
        </Button>
      </Card>

      <Card title="Statut">
        <div className="grid gap-3 sm:grid-cols-2">
          <Select label="Nouveau statut" value={statusForm.status} onChange={(e) => setStatusForm((f) => ({ ...f, status: e.target.value }))}>
            <option value="">Choisir…</option>
            {["open", "in_progress", "resolved", "rejected"]
              .filter((s) => s !== r.status)
              .map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABELS[s]}
                </option>
              ))}
          </Select>
          <ReasonField value={statusForm.reason} onChange={(v) => setStatusForm((f) => ({ ...f, reason: v }))} label="Motif (obligatoire pour refuser ou ouvrir une demande non vérifiée)" />
        </div>
        {r.status === "unverified" && (
          <div className="mt-3">
            <IdentityCheckbox checked={statusForm.identityVerifiedOffline} onChange={(v) => setStatusForm((f) => ({ ...f, identityVerifiedOffline: v }))} />
          </div>
        )}
        <Button
          className="mt-3"
          size="sm"
          loading={busy === "status"}
          disabled={!statusForm.status}
          onClick={async () =>
            (await act("status", `${base}/status`, statusForm, "Statut modifié — la personne est prévenue par courriel")) &&
            setStatusForm({ status: "", reason: "", identityVerifiedOffline: false })
          }
        >
          Changer le statut
        </Button>
      </Card>

      {!closed && r.type === "recovery" && account && (
        <Card title="Actions — récupération de compte (UC-50)">
          <p className="text-sm text-slate-600 mb-3">
            Le support ne voit ni ne définit jamais de mot de passe : le lien de réinitialisation part à l'adresse du compte.
          </p>
          <ReasonField value={reason} onChange={setReason} />
          <div className="flex flex-wrap gap-2 mt-3">
            <Button size="sm" disabled={!isOpen} loading={busy === "reset"} onClick={() => act("reset", `${base}/send-reset-link`, { reason }, "Lien de réinitialisation envoyé à l'adresse du compte")}>
              <KeyRound size={14} /> Envoyer un lien de réinitialisation
            </Button>
            <Button size="sm" variant="outline" disabled={!isOpen} loading={busy === "unlock"} onClick={() => act("unlock", `${base}/unlock`, { reason }, "Tentatives de connexion débloquées")}>
              <Unlock size={14} /> Débloquer la connexion
            </Button>
          </div>
          {!isOpen && <p className="text-xs text-slate-500 mt-2">Ces deux actions exigent une demande vérifiée (ouverte ou en cours).</p>}

          <div className="mt-6 pt-4 border-t border-slate-100 space-y-3">
            <h3 className="font-semibold flex items-center gap-2">
              <Mail size={16} /> Changer l'adresse du compte
            </h3>
            <p className="text-sm text-slate-600">
              L'ancienne adresse reçoit un avis, la nouvelle un lien de vérification ; toutes les sessions du compte sont fermées.
            </p>
            <Input label="Nouvelle adresse" type="email" value={emailForm.newEmail} onChange={(e) => setEmailForm((f) => ({ ...f, newEmail: e.target.value }))} />
            <IdentityCheckbox checked={emailForm.identityVerifiedOffline} onChange={(v) => setEmailForm((f) => ({ ...f, identityVerifiedOffline: v }))} />
            <ReasonField
              label="Motif détaillé : comment l'identité a-t-elle été vérifiée ?"
              minLength={20}
              value={emailForm.reason}
              onChange={(v) => setEmailForm((f) => ({ ...f, reason: v }))}
            />
            <Button
              size="sm"
              variant="danger"
              disabled={!emailForm.identityVerifiedOffline || emailForm.reason.trim().length < 20 || !emailForm.newEmail}
              loading={busy === "email"}
              onClick={() => act("email", `${base}/change-email`, emailForm, "Adresse changée — lien de vérification envoyé")}
            >
              Changer l'adresse
            </Button>
          </div>
        </Card>
      )}

      {!closed && r.type === "data_deletion" && account && (
        <Card title="Action — suppression des données (UC-51)">
          <p className="text-sm text-slate-600 mb-3">
            Mêmes règles que la suppression par la personne : sa fiche reste à la famille (archivée) sauf demande explicite ;
            les dossiers qu'elle gérait seule sont confiés à l'administrateur familial ; un administrateur d'un espace qui
            compte d'autres comptes ne peut pas être supprimé.
          </p>
          <Button
            variant="danger"
            size="sm"
            disabled={!isOpen}
            onClick={() => setDeletion({ confirmEmail: "", reason: "", deleteMedicalRecord: false })}
          >
            <Trash2 size={14} /> Supprimer le compte…
          </Button>
          {!isOpen && <p className="text-xs text-slate-500 mt-2">La demande doit être confirmée (identité) et ouverte.</p>}
        </Card>
      )}

      {!closed && r.type === "report" && account && (
        <Card title="Action — suspension (UC-52)">
          {account.suspension ? (
            <p className="text-sm">
              Compte déjà suspendu.{" "}
              <Link to={`/admin/comptes/${account.id}`} className="underline">
                Lever la suspension depuis la fiche du compte
              </Link>
            </p>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-slate-600">
                Blocage temporaire et réversible : connexion refusée, sessions fermées, appareils push retirés, liens médecin
                révoqués. Données, fiche et rôles restent intacts. La personne reçoit le motif ; l'administrateur familial est
                prévenu sans le motif.
              </p>
              <ReasonField value={suspendForm.reason} onChange={(v) => setSuspendForm((f) => ({ ...f, reason: v }))} label="Motif (communiqué à la personne)" />
              <Input
                label="Jusqu'au (vide : jusqu'à nouvel ordre)"
                type="datetime-local"
                value={suspendForm.until}
                onChange={(e) => setSuspendForm((f) => ({ ...f, until: e.target.value }))}
              />
              <Button
                variant="danger"
                size="sm"
                disabled={!isOpen}
                loading={busy === "suspend"}
                onClick={() =>
                  act(
                    "suspend",
                    `${base}/suspend`,
                    { reason: suspendForm.reason, until: suspendForm.until ? new Date(suspendForm.until).toISOString() : null },
                    "Compte suspendu"
                  )
                }
              >
                <UserX size={14} /> Suspendre le compte
              </Button>
            </div>
          )}
        </Card>
      )}

      <Modal open={!!deletion} onClose={() => setDeletion(null)} title="Supprimer le compte">
        {deletion && account && (
          <div className="space-y-4">
            <div className="flex gap-3 bg-red-50 border border-red-200 text-red-800 rounded-xl p-3 text-sm">
              <AlertTriangle size={18} className="flex-shrink-0 mt-0.5" />
              <p>
                Suppression <strong>définitive</strong> du compte <strong>{account.email}</strong>. Pour confirmer, retapez
                l'adresse du compte.
              </p>
            </div>
            {r.deleteMedicalRecord && (
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={deletion.deleteMedicalRecord}
                  onChange={(e) => setDeletion((d) => ({ ...d, deleteMedicalRecord: e.target.checked }))}
                />
                <span>Supprimer aussi la fiche médicale (demandé explicitement par la personne)</span>
              </label>
            )}
            <ReasonField value={deletion.reason} onChange={(v) => setDeletion((d) => ({ ...d, reason: v }))} />
            <Input label="Adresse du compte" value={deletion.confirmEmail} onChange={(e) => setDeletion((d) => ({ ...d, confirmEmail: e.target.value }))} />
            <div className="flex gap-3">
              <Button variant="ghost" className="flex-1" onClick={() => setDeletion(null)}>
                Annuler
              </Button>
              <Button
                variant="danger"
                className="flex-1"
                loading={busy === "delete"}
                disabled={deletion.confirmEmail.trim().toLowerCase() !== account.email || deletion.reason.trim().length < 5}
                onClick={async () => (await act("delete", `${base}/delete-account`, deletion, "Compte supprimé")) && setDeletion(null)}
              >
                Supprimer définitivement
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
