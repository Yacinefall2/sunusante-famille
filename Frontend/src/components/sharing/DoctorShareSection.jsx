import { useEffect, useState } from "react";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Badge } from "../ui/Badge";
import { QrImage } from "./QrImage";
import { Stethoscope, Plus, Loader2, Copy, Share2, AlertTriangle, Ban, Clock, User, FileText } from "lucide-react";
import { SHARE_DURATIONS, shareContentsLabel, shareStateInfo } from "../../lib/partage";
import { formatDate, formatDateTime } from "../../lib/utils";
import toast from "react-hot-toast";

const defaultForm = {
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
  // Lien tout juste créé : renvoyé une seule fois par le serveur.
  const [created, setCreated] = useState(null);
  const [revoking, setRevoking] = useState(null);

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

  const closeForm = () => {
    setShowForm(false);
    setCreated(null);
  };

  const toggleDoc = (id, on) =>
    setForm((p) => ({ ...p, documentIds: on ? [...p.documentIds, id] : p.documentIds.filter((x) => x !== id) }));

  const nothingChecked = !form.includeEssentials && !form.includeTreatments && !form.includeVaccinations && form.documentIds.length === 0;

  const create = async () => {
    if (nothingChecked) {
      toast.error("Cochez au moins un élément à partager");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/doctor-shares", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memberId: member.id, ...form }),
      });
      if (res.ok) {
        const data = await res.json();
        setCreated(data);
        toast.success("Lien médecin créé");
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

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(created.url);
      toast.success("Lien copié");
    } catch {
      toast.error("Copie impossible : sélectionnez le lien manuellement");
    }
  };

  const shareLink = async () => {
    const text = `Dossier médical de ${member.firstName} ${member.lastName} (SunuSanté Famille) — lien à usage unique, à ouvrir par le médecin :`;
    if (navigator.share) {
      try {
        await navigator.share({ title: "Dossier médical partagé", text, url: created.url });
        return;
      } catch (e) {
        if (e?.name === "AbortError") return;
      }
    }
    window.open(`https://wa.me/?text=${encodeURIComponent(`${text} ${created.url}`)}`, "_blank", "noopener");
  };

  const revoke = async (share) => {
    if (!confirm("Révoquer ce lien ? Le médecin ne pourra plus consulter le dossier avec ce lien.")) return;
    setRevoking(share.id);
    try {
      const res = await fetch(`/api/doctor-shares/${share.id}/revoke`, { method: "POST" });
      if (res.ok) {
        toast.success("Lien révoqué");
        load();
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || "Erreur lors de la révocation");
      }
    } finally {
      setRevoking(null);
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
            <p className="text-xs text-gray-500">Un lien temporaire, à usage unique, en lecture seule.</p>
          </div>
        </div>
        {canManage && (
          <Button onClick={openForm}>
            <Plus size={16} />
            Créer un lien médecin
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
              const active = s.state === "pending" || s.state === "opened";
              return (
                <div key={s.id} className="flex flex-col sm:flex-row sm:items-center gap-3 bg-gray-50 rounded-xl p-4">
                  <div className="flex-1 min-w-0 space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge variant={st.variant}>{st.label}</Badge>
                      <span className="text-xs text-gray-500">Créé le {formatDateTime(s.createdAt)}</span>
                    </div>
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
                  {active && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-red-600 hover:bg-red-50 flex-shrink-0"
                      loading={revoking === s.id}
                      onClick={() => revoke(s)}
                    >
                      <Ban size={14} />
                      Révoquer
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <Modal open={showForm} onClose={closeForm} title={created ? "Lien médecin créé" : "Créer un lien médecin"} size="lg">
        {created ? (
          <div className="space-y-5">
            <div className="flex items-start gap-3 bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-800">
              <AlertTriangle size={18} className="flex-shrink-0 mt-0.5" />
              <p className="font-semibold">
                Ce lien ne s'ouvre qu'une seule fois, sur un seul appareil : celui du médecin. Ne l'ouvrez pas vous-même.
                Il ne sera plus affiché ensuite.
              </p>
            </div>

            <div className="flex flex-col items-center gap-2">
              <QrImage value={created.url} size={220} className="rounded-xl border border-gray-200 p-2" alt="QR code du lien médecin" />
              <p className="text-xs text-gray-500 text-center">Le médecin peut scanner ce QR code avec son téléphone.</p>
            </div>

            <div>
              <p className="text-sm font-semibold text-gray-700 mb-1.5">Lien à transmettre au médecin</p>
              <input
                readOnly
                value={created.url}
                onFocus={(e) => e.target.select()}
                className="w-full px-3 py-2.5 rounded-xl border border-gray-200 bg-gray-50 text-xs text-gray-700 font-mono"
              />
            </div>

            <p className="text-xs text-gray-500">
              Valable jusqu'au {formatDateTime(created.expiresAt)} · {shareContentsLabel(created)}
            </p>

            <div className="flex flex-col sm:flex-row gap-3">
              <Button variant="outline" onClick={copyLink} className="flex-1">
                <Copy size={15} />
                Copier
              </Button>
              <Button variant="secondary" onClick={shareLink} className="flex-1">
                <Share2 size={15} />
                Partager
              </Button>
              <Button onClick={closeForm} className="flex-1">
                Terminé
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-5">
            <p className="text-sm text-gray-600">
              Dossier de <strong>{member.firstName} {member.lastName}</strong>. Le médecin ne verra que ce que vous cochez,
              en lecture seule, jusqu'à l'expiration du lien.
            </p>

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
              <Button onClick={create} loading={saving} disabled={nothingChecked} className="flex-1">
                Créer le lien
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </section>
  );
}
