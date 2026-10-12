import { useEffect, useState } from "react";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Badge } from "../ui/Badge";
import { Input } from "../ui/Input";
import { Stethoscope, Plus, Loader2, MailCheck, Mail, Clock, User, FileText, Ban } from "lucide-react";
import { SHARE_DURATIONS, shareContentsLabel, shareStateInfo } from "../../lib/partage";
import { formatDate, formatDateTime } from "../../lib/utils";
import toast from "react-hot-toast";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const defaultForm = {
  doctorEmail: "",
  duration: "2h",
  includeEssentials: true,
  includeTreatments: false,
  includeVaccinations: false,
  documentIds: [],
};

function Check({ checked, onChange, label, hint }) {
  return (
    <label className="flex items-start gap-3 p-3 rounded-xl border border-gray-200 hover:border-teal-300 cursor-pointer bg-white">
      <input type="checkbox" className="mt-1 w-4 h-4" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <span className="block text-sm font-semibold text-gray-800">{label}</span>
        {hint && <span className="block text-xs text-gray-500">{hint}</span>}
      </span>
    </label>
  );
}

// Section « Partager avec un médecin » de la page Partage & urgence.
export function DoctorShareSection({ member, canManage }) {
  const [shares, setShares] = useState([]);
  const [loading, setLoading] = useState(false);
  const [documents, setDocuments] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(defaultForm);
  const [saving, setSaving] = useState(false);
  // Lien tout juste envoyé au médecin (le lien lui-même n'est jamais affiché).
  const [created, setCreated] = useState(null);

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/doctor-shares?memberId=${member.id}`);
      const data = res.ok ? await res.json() : [];
      setShares(Array.isArray(data) ? data : []);
    } catch {
      setShares([]);
    } finally {
      setLoading(false);
    }
  };

  const loadDocuments = async () => {
    try {
      const res = await fetch(`/api/documents?memberId=${member.id}`);
      const data = res.ok ? await res.json() : [];
      setDocuments(Array.isArray(data) ? data : []);
    } catch {
      setDocuments([]);
    }
  };

  useEffect(() => {
    setShares([]);
    setDocuments([]);
    if (canManage) {
      load();
      loadDocuments();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [member.id, canManage]);

  const openForm = () => {
    setForm(defaultForm);
    setCreated(null);
    setShowForm(true);
    loadDocuments();
  };

  // Révocation : coupe l'accès du médecin immédiatement, même déjà ouvert.
  const [revokingId, setRevokingId] = useState(null);
  const revoke = async (share) => {
    const who = share.doctorEmail ? ` envoyé à ${share.doctorEmail}` : "";
    if (!confirm(`Révoquer le lien${who} ? Le médecin n'aura plus accès au dossier, même s'il l'a déjà ouvert.`)) return;
    setRevokingId(share.id);
    try {
      const res = await fetch(`/api/doctor-shares/${share.id}/revoke`, { method: "POST" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Révocation impossible");
      toast.success("Lien révoqué : le médecin n'a plus accès au dossier");
      await load();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setRevokingId(null);
    }
  };

  const closeForm = () => {
    setShowForm(false);
    setCreated(null);
  };

  const toggleDoc = (id, on) =>
    setForm((p) => ({ ...p, documentIds: on ? [...p.documentIds, id] : p.documentIds.filter((x) => x !== id) }));

  const nothingChecked = !form.includeEssentials && !form.includeTreatments && !form.includeVaccinations && form.documentIds.length === 0;

  const emailValid = EMAIL_RE.test(form.doctorEmail.trim());

  const create = async () => {
    if (!emailValid) {
      toast.error("Renseignez l'adresse courriel du médecin");
      return;
    }
    if (nothingChecked) {
      toast.error("Cochez au moins un élément à partager");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/doctor-shares", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memberId: member.id, ...form, doctorEmail: form.doctorEmail.trim() }),
      });
      if (res.ok) {
        const data = await res.json();
        setCreated(data);
        toast.success("Lien envoyé au médecin");
        load();
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || (res.status === 403 ? "Vous ne pouvez pas partager ce dossier" : "Erreur lors de la création du lien"));
      }
    } catch {
      toast.error("Erreur lors de la création du lien");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
      <div className="px-6 py-4 bg-gradient-to-r from-blue-50 to-teal-50 border-b border-blue-100 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-blue-100 rounded-xl flex items-center justify-center">
            <Stethoscope size={20} className="text-blue-600" />
          </div>
          <div>
            <h3 className="font-bold text-gray-800">Partager avec un médecin</h3>
            <p className="text-xs text-gray-500">Un lien temporaire, à usage unique, en lecture seule, envoyé par courriel au médecin.</p>
          </div>
        </div>
        {canManage && (
          <Button onClick={openForm}>
            <Plus size={16} />
            Envoyer un lien médecin
          </Button>
        )}
      </div>

      <div className="p-6">
        {!canManage ? (
          <p className="text-sm text-gray-600 bg-gray-50 rounded-xl p-4">
            Seuls le titulaire de la fiche (s'il est majeur) et les personnes qui gèrent son dossier (gestionnaire,
            parent avec accès complet) peuvent partager le dossier de {member.firstName} avec un médecin.
          </p>
        ) : loading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="animate-spin text-teal-600" size={28} />
          </div>
        ) : shares.length === 0 ? (
          <p className="text-sm text-gray-400 italic text-center py-6">Aucun lien médecin créé pour cette fiche.</p>
        ) : (
          <div className="space-y-3">
            {shares.map((s) => {
              const st = shareStateInfo(s);
              return (
                <div key={s.id} className="flex flex-col sm:flex-row sm:items-center gap-3 bg-gray-50 rounded-xl p-4">
                  <div className="flex-1 min-w-0 space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge variant={st.variant}>{st.label}</Badge>
                      <span className="text-xs text-gray-500">Créé le {formatDateTime(s.createdAt)}</span>
                    </div>
                    {s.doctorEmail && (
                      <p className="text-sm font-semibold text-gray-800 flex items-center gap-1.5 min-w-0">
                        <Mail size={13} className="text-blue-500 flex-shrink-0" />
                        <span className="truncate">{s.doctorEmail}</span>
                      </p>
                    )}
                    <p className="text-sm text-gray-700">{shareContentsLabel(s)}</p>
                    <div className="flex flex-wrap gap-3 text-xs text-gray-500">
                      <span className="flex items-center gap-1">
                        <Clock size={11} />
                        {s.state === "expired" ? "Expiré le" : "Expire le"} {formatDateTime(s.expiresAt)}
                      </span>
                      {s.createdByName && (
                        <span className="flex items-center gap-1">
                          <User size={11} />
                          Par {s.createdByName}
                        </span>
                      )}
                      {s.lastViewedAt && <span>Dernière consultation le {formatDateTime(s.lastViewedAt)}</span>}
                      {s.revokedAt && <span>Révoqué le {formatDateTime(s.revokedAt)}</span>}
                    </div>
                  </div>
                  {(s.state === "pending" || s.state === "opened") && (
                    <Button
                      variant="ghost"
                      className="text-red-600 hover:bg-red-50 flex-shrink-0"
                      onClick={() => revoke(s)}
                      loading={revokingId === s.id}
                    >
                      <Ban size={15} />
                      Révoquer
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <Modal open={showForm} onClose={closeForm} title={created ? "Lien envoyé au médecin" : "Envoyer un lien médecin"} size="lg">
        {created ? (
          <div className="space-y-5">
            <div className="flex flex-col items-center text-center gap-3 py-2">
              <div className="w-16 h-16 bg-emerald-50 rounded-2xl flex items-center justify-center">
                <MailCheck size={30} className="text-emerald-600" />
              </div>
              <p className="text-sm text-gray-700">
                Un courriel avec un bouton d'accès au dossier de <strong>{member.firstName}</strong> a été envoyé à
              </p>
              <p className="text-base font-bold text-gray-900 break-all">{created.doctorEmail}</p>
            </div>

            <div className="bg-blue-50 border border-blue-100 rounded-xl p-4 text-sm text-blue-900 space-y-1">
              <p>Le lien ne s'ouvre qu'une seule fois, sur un seul appareil : celui du médecin.</p>
              <p>Valable jusqu'au {formatDateTime(created.expiresAt)} · {shareContentsLabel(created)}</p>
            </div>

            <p className="text-xs text-gray-500">
              Vous serez prévenu(e) quand le médecin ouvrira le dossier. S'il ne reçoit rien, vérifiez ses courriels
              indésirables ou envoyez un nouveau lien.
            </p>

            <Button onClick={closeForm} className="w-full">
              Terminé
            </Button>
          </div>
        ) : (
          <div className="space-y-5">
            <p className="text-sm text-gray-600">
              Dossier de <strong>{member.firstName} {member.lastName}</strong>. Le médecin ne verra que ce que vous cochez,
              en lecture seule, jusqu'à l'expiration du lien.
            </p>

            <div>
              <Input
                label="Adresse courriel du médecin *"
                type="email"
                inputMode="email"
                autoComplete="email"
                placeholder="dr.ndiaye@clinique.sn"
                value={form.doctorEmail}
                onChange={(e) => setForm((p) => ({ ...p, doctorEmail: e.target.value }))}
              />
              <p className="text-xs text-gray-500 mt-1.5">
                Le lien est envoyé directement au médecin par courriel : il n'est affiché à personne d'autre.
              </p>
            </div>

            <div>
              <p className="text-sm font-semibold text-gray-700 mb-2">Durée de validité</p>
              <div className="grid grid-cols-3 gap-2">
                {SHARE_DURATIONS.map((d) => (
                  <button
                    key={d.value}
                    type="button"
                    onClick={() => setForm((p) => ({ ...p, duration: d.value }))}
                    className={`px-3 py-2.5 rounded-xl text-sm font-semibold border transition-all ${
                      form.duration === d.value
                        ? "bg-teal-600 text-white border-teal-600 shadow-sm"
                        : "bg-white text-gray-600 border-gray-200 hover:border-teal-300"
                    }`}
                  >
                    {d.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <p className="text-sm font-semibold text-gray-700">Éléments partagés</p>
              <Check
                checked={form.includeEssentials}
                onChange={(v) => setForm((p) => ({ ...p, includeEssentials: v }))}
                label="Informations essentielles"
                hint="Groupe sanguin, allergies, médecin traitant"
              />
              <Check
                checked={form.includeTreatments}
                onChange={(v) => setForm((p) => ({ ...p, includeTreatments: v }))}
                label="Traitements en cours"
              />
              <Check
                checked={form.includeVaccinations}
                onChange={(v) => setForm((p) => ({ ...p, includeVaccinations: v }))}
                label="Vaccinations"
              />
            </div>

            <div>
              <p className="text-sm font-semibold text-gray-700 mb-2">Documents</p>
              {documents.length === 0 ? (
                <p className="text-sm text-gray-400 italic">Aucun document sur cette fiche.</p>
              ) : (
                <div className="space-y-1.5 max-h-56 overflow-y-auto pr-1">
                  {documents.map((d) => (
                    <label key={d.id} className="flex items-center gap-3 px-3 py-2 rounded-xl hover:bg-gray-50 cursor-pointer">
                      <input
                        type="checkbox"
                        className="w-4 h-4"
                        checked={form.documentIds.includes(d.id)}
                        onChange={(e) => toggleDoc(d.id, e.target.checked)}
                      />
                      <FileText size={15} className="text-gray-400 flex-shrink-0" />
                      <span className="text-sm text-gray-700 flex-1 min-w-0 truncate">{d.title}</span>
                      {d.uploadedAt && <span className="text-xs text-gray-400">{formatDate(d.uploadedAt)}</span>}
                    </label>
                  ))}
                </div>
              )}
            </div>

            {nothingChecked && <p className="text-xs text-red-600">Cochez au moins un élément à partager.</p>}

            <div className="flex gap-3 pt-2">
              <Button variant="ghost" onClick={closeForm} className="flex-1">
                Annuler
              </Button>
              <Button onClick={create} loading={saving} disabled={nothingChecked || !emailValid} className="flex-1">
                <Mail size={15} />
                Envoyer le lien
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </section>
  );
}
