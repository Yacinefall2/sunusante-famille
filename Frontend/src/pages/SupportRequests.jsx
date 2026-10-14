import { useEffect, useState } from "react";
import { LifeBuoy, Loader2, ShieldAlert, Send, Inbox } from "lucide-react";
import toast from "react-hot-toast";
import { AppShell } from "../components/layout/AppShell";
import { Button } from "../components/ui/Button";
import { Badge } from "../components/ui/Badge";
import { Input, Select, Textarea } from "../components/ui/Input";
import { formatDateTime } from "../lib/utils";

// « Contacter le support » et « Mes demandes » (UC-51 et autres questions).
// La demande est rattachée au compte connecté. Pour une suppression des
// données — « demande écrite et identité confirmée » — le mot de passe est
// redemandé et un lien de confirmation part à l'adresse du compte.

const TYPE_LABELS = {
  recovery: "Récupération de compte",
  data_deletion: "Supprimer mes données",
  report: "Signalement d'un compte",
  other: "Autre question",
};
const STATUS = {
  unverified: { label: "En attente de votre confirmation", variant: "warning" },
  open: { label: "Ouverte", variant: "info" },
  in_progress: { label: "En cours de traitement", variant: "info" },
  resolved: { label: "Traitée", variant: "success" },
  rejected: { label: "Refusée", variant: "default" },
};

const EMPTY = { type: "other", description: "", deleteMedicalRecord: false, password: "" };

export default function SupportRequestsPage() {
  const [requests, setRequests] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [sending, setSending] = useState(false);
  const [replies, setReplies] = useState({});
  const [replying, setReplying] = useState(null);

  const load = async () => {
    try {
      const res = await fetch("/api/support/requests");
      if (!res.ok) throw new Error();
      setRequests(await res.json());
    } catch {
      setRequests([]);
      toast.error("Impossible de charger vos demandes");
    }
  };

  useEffect(() => {
    load();
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    setSending(true);
    try {
      const res = await fetch("/api/support/requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Échec de l'envoi");
      toast.success(
        data.confirmationSent
          ? `Demande ${data.reference} enregistrée : confirmez-la avec le lien envoyé à votre adresse courriel`
          : `Demande ${data.reference} envoyée au support`,
        { duration: 7000 }
      );
      setForm(EMPTY);
      load();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSending(false);
    }
  };

  const sendReply = async (id) => {
    setReplying(id);
    try {
      const res = await fetch(`/api/support/requests/${id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: replies[id] ?? "" }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Échec de l'envoi");
      setRequests((list) => list.map((r) => (r.id === id ? data : r)));
      setReplies((r) => ({ ...r, [id]: "" }));
      toast.success("Message envoyé au support");
    } catch (err) {
      toast.error(err.message);
    } finally {
      setReplying(null);
    }
  };

  const deletion = form.type === "data_deletion";

  return (
    <AppShell>
      <div className="max-w-2xl space-y-5">
        <div>
          <h2 className="text-xl font-bold text-gray-800">Contacter le support</h2>
          <p className="text-sm text-gray-500">Le support gère les comptes ; il n'a jamais accès aux dossiers de santé.</p>
        </div>

        <section className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6">
          <div className="flex items-start gap-3 mb-4">
            <div className="w-10 h-10 rounded-xl bg-teal-50 flex items-center justify-center flex-shrink-0">
              <LifeBuoy size={18} className="text-teal-600" />
            </div>
            <div>
              <h3 className="font-bold text-gray-800">Nouvelle demande</h3>
              <p className="text-xs text-gray-500">Vous recevrez les réponses par courriel et ici, dans « Mes demandes ».</p>
            </div>
          </div>
          <div className="flex gap-2 bg-amber-50 border border-amber-200 text-amber-900 rounded-xl p-3 text-sm mb-4">
            <ShieldAlert size={16} className="flex-shrink-0 mt-0.5" />
            <p>
              <strong>N'indiquez aucune information médicale</strong> (maladie, traitement, résultat…) dans votre demande.
            </p>
          </div>
          <form onSubmit={submit} className="space-y-4">
            <Select label="Objet" value={form.type} onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))}>
              <option value="other">Autre question</option>
              <option value="data_deletion">Supprimer mes données</option>
            </Select>
            <Textarea
              label="Votre demande"
              required
              minLength={10}
              maxLength={4000}
              rows={4}
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            />
            {deletion && (
              <>
                <p className="text-sm text-gray-600 bg-gray-50 rounded-xl p-3">
                  Le support supprimera votre compte avec les mêmes règles que « Supprimer mon compte » : votre fiche reste à
                  votre famille (archivée) sauf si vous demandez aussi son effacement. Pour confirmer qu'il s'agit bien de vous,
                  saisissez votre mot de passe : un lien de confirmation partira ensuite à votre adresse courriel.
                </p>
                <label className="flex items-start gap-3 p-3 rounded-xl border border-gray-200 cursor-pointer">
                  <input
                    type="checkbox"
                    className="mt-1 w-4 h-4"
                    checked={form.deleteMedicalRecord}
                    onChange={(e) => setForm((f) => ({ ...f, deleteMedicalRecord: e.target.checked }))}
                  />
                  <span className="text-sm text-gray-700">
                    <span className="font-semibold block">Supprimer aussi ma fiche médicale</span>
                    Sinon, elle reste à la famille, archivée. Possible seulement si vous êtes majeur(e).
                  </span>
                </label>
                <Input
                  label="Mot de passe actuel"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={form.password}
                  onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                />
              </>
            )}
            <Button type="submit" loading={sending} disabled={form.description.trim().length < 10 || (deletion && !form.password)}>
              Envoyer au support
            </Button>
          </form>
        </section>

        <section className="space-y-3">
          <h3 className="font-bold text-gray-800 flex items-center gap-2">
            <Inbox size={18} className="text-teal-600" /> Mes demandes
          </h3>
          {!requests ? (
            <Loader2 className="animate-spin text-teal-600" size={28} />
          ) : requests.length === 0 ? (
            <p className="text-sm text-gray-500">Aucune demande pour l'instant.</p>
          ) : (
            requests.map((r) => {
              const status = STATUS[r.status] ?? { label: r.status, variant: "default" };
              const closed = r.status === "resolved" || r.status === "rejected";
              return (
                <article key={r.id} className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5 space-y-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <strong className="text-gray-800">{r.reference}</strong>
                    <span className="text-sm text-gray-600">{TYPE_LABELS[r.type] ?? r.type}</span>
                    <Badge variant={status.variant}>{status.label}</Badge>
                    <span className="text-xs text-gray-400 ml-auto">{formatDateTime(r.createdAt)}</span>
                  </div>
                  <p className="text-sm text-gray-700 whitespace-pre-wrap">{r.description}</p>
                  {r.status === "unverified" && (
                    <p className="text-xs text-amber-800 bg-amber-50 rounded-lg px-3 py-2">
                      Suivez le lien de confirmation reçu par courriel pour que le support traite cette demande.
                    </p>
                  )}
                  {r.messages.length > 0 && (
                    <ul className="space-y-2">
                      {r.messages.map((m) => (
                        <li key={m.id} className={`rounded-xl p-3 text-sm ${m.fromSupport ? "bg-teal-50" : "bg-gray-50"}`}>
                          <p className="text-xs text-gray-500 mb-1">
                            {m.fromSupport ? m.author : "Vous"} — {formatDateTime(m.createdAt)}
                          </p>
                          <p className="whitespace-pre-wrap">{m.body}</p>
                        </li>
                      ))}
                    </ul>
                  )}
                  {!closed && (
                    <div className="flex flex-col sm:flex-row gap-2 sm:items-end">
                      <div className="flex-1">
                        <Textarea
                          label="Répondre au support"
                          rows={2}
                          value={replies[r.id] ?? ""}
                          onChange={(e) => setReplies((x) => ({ ...x, [r.id]: e.target.value }))}
                        />
                      </div>
                      <Button size="sm" loading={replying === r.id} disabled={!(replies[r.id] ?? "").trim()} onClick={() => sendReply(r.id)}>
                        <Send size={14} /> Envoyer
                      </Button>
                    </div>
                  )}
                </article>
              );
            })
          )}
        </section>
      </div>
    </AppShell>
  );
}
