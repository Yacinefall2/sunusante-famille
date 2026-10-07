import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "../ui/Button";
import { Textarea } from "../ui/Input";
import { Badge } from "../ui/Badge";
import { QrImage } from "./QrImage";
import { EmergencyView } from "./EmergencyView";
import { Siren, Loader2, Printer, Smartphone, RefreshCw, Eye, Bell, Save, Copy, ExternalLink } from "lucide-react";
import {
  EMERGENCY_FIELD_OPTIONS,
  EMPTY_EMERGENCY_FIELDS,
  EXTRA_INFO_MAX,
  buildEmergencyView,
  downloadBlob,
  emergencyLines,
  emergencyLockScreenBlob,
} from "../../lib/partage";
import { formatDateTime } from "../../lib/utils";
import toast from "react-hot-toast";

// Carte imprimable (format carte bancaire, 85,6 x 54 mm) : infos vitales en
// clair pour fonctionner sans réseau, plus le QR code de la fiche à jour.
// Rendue hors de #root : seule elle est imprimée (voir index.css).
function EmergencyPrintCard({ view, url }) {
  const lines = emergencyLines(view).filter((l) => l.value);
  return createPortal(
    <div className="emergency-print-card">
      <div className="epc-card">
        <div className="epc-head">URGENCE — SunuSanté</div>
        <div className="epc-body">
          <div className="epc-text">
            <div className="epc-name">
              {view.firstName} {view.lastName}
            </div>
            {lines.map((l) => (
              <div key={l.key} className={l.danger ? "epc-line epc-danger" : "epc-line"}>
                <b>{l.label} :</b> {l.value}
              </div>
            ))}
          </div>
          <div className="epc-qr">
            <QrImage value={url} size={96} alt="QR code de la fiche d'urgence" />
          </div>
        </div>
        <div className="epc-foot">Fiche d'urgence — scannez pour la version à jour</div>
      </div>
    </div>,
    document.body
  );
}

function Toggle({ checked, onChange, label }) {
  return (
    <label className="flex items-center justify-between gap-4 cursor-pointer">
      <span className="text-sm font-bold text-gray-800">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative w-12 h-7 rounded-full transition-colors flex-shrink-0 ${checked ? "bg-red-600" : "bg-gray-300"}`}
      >
        <span
          className={`absolute top-1 left-1 w-5 h-5 bg-white rounded-full shadow transition-transform ${checked ? "translate-x-5" : ""}`}
        />
      </button>
    </label>
  );
}

const settingsOf = (data) => ({
  active: !!data?.active,
  fields: { ...EMPTY_EMERGENCY_FIELDS, ...(data?.fields ?? {}) },
  extraInfo: data?.extraInfo ?? "",
});

const sameSettings = (a, b) =>
  a.active === b.active &&
  a.extraInfo.trim() === b.extraInfo.trim() &&
  EMERGENCY_FIELD_OPTIONS.every((f) => !!a.fields[f.key] === !!b.fields[f.key]);

// Section « Fiche d'urgence » de la page Partage & urgence.
export function EmergencySection({ member }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState(settingsOf(null));
  const [treatments, setTreatments] = useState([]);
  const [saving, setSaving] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [imaging, setImaging] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/emergency/${member.id}`);
      if (res.ok) {
        const d = await res.json();
        setData(d);
        setDraft(settingsOf(d));
      } else {
        setData(null);
      }
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  };

  const loadTreatments = async () => {
    try {
      const res = await fetch(`/api/treatments?memberId=${member.id}`);
      const rows = res.ok ? await res.json() : [];
      setTreatments(Array.isArray(rows) ? rows.filter((t) => t.isActive) : []);
    } catch {
      setTreatments([]);
    }
  };

  useEffect(() => {
    setData(null);
    setTreatments([]);
    load();
    loadTreatments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [member.id]);

  // Aperçu en direct, calculé avec les réglages en cours d'édition
  const livePreview = useMemo(() => buildEmergencyView(member, treatments, draft), [member, treatments, draft]);
  const saved = settingsOf(data);
  const dirty = data ? !sameSettings(draft, saved) : false;
  const nothingChecked = !EMERGENCY_FIELD_OPTIONS.some((f) => draft.fields[f.key]) && !draft.extraInfo.trim();

  const setField = (key, value) => setDraft((p) => ({ ...p, fields: { ...p.fields, [key]: value } }));

  const save = async () => {
    if (draft.active && nothingChecked) {
      toast.error("Cochez au moins une information avant d'activer la fiche d'urgence");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/emergency/${member.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: draft.active, fields: draft.fields, extraInfo: draft.extraInfo.trim() }),
      });
      if (res.ok) {
        const d = await res.json();
        setData(d);
        setDraft(settingsOf(d));
        toast.success(d.active ? "Fiche d'urgence enregistrée" : "Fiche d'urgence enregistrée (désactivée)");
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || "Erreur lors de l'enregistrement");
      }
    } catch {
      toast.error("Erreur lors de l'enregistrement");
    } finally {
      setSaving(false);
    }
  };

  const regenerate = async () => {
    if (!confirm("Régénérer le QR code ? L'ancienne carte imprimée ne fonctionnera plus.")) return;
    setRegenerating(true);
    try {
      const res = await fetch(`/api/emergency/${member.id}/regenerate`, { method: "POST" });
      if (res.ok) {
        const d = await res.json();
        setData(d);
        toast.success("Nouveau QR code généré : pensez à réimprimer la carte");
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || "Erreur lors de la régénération");
      }
    } finally {
      setRegenerating(false);
    }
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(data.url);
      toast.success("Lien copié");
    } catch {
      toast.error("Copie impossible : sélectionnez le lien manuellement");
    }
  };

  const printCard = () => {
    document.body.classList.add("printing-card");
    const cleanup = () => {
      document.body.classList.remove("printing-card");
      window.removeEventListener("afterprint", cleanup);
    };
    window.addEventListener("afterprint", cleanup);
    // Laisse le temps au QR code de la carte d'être prêt
    setTimeout(() => window.print(), 150);
  };

  const downloadLockScreen = async () => {
    setImaging(true);
    try {
      const blob = await emergencyLockScreenBlob(data.preview, data.url);
      const slug = `${member.firstName}`.normalize("NFD").replace(/[^\w-]+/g, "").toLowerCase() || "fiche";
      downloadBlob(blob, `urgence-${slug}.png`);
    } catch {
      toast.error("Impossible de générer l'image");
    } finally {
      setImaging(false);
    }
  };

  const canEdit = !!data?.canEdit;
  // Carte et QR : d'après les réglages ENREGISTRÉS (vue publique du serveur)
  const published = data?.active && data?.url && data?.preview;

  return (
    <section className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
      <div className="px-6 py-4 bg-gradient-to-r from-red-50 to-orange-50 border-b border-red-100 flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-red-100 rounded-xl flex items-center justify-center">
            <Siren size={20} className="text-red-600" />
          </div>
          <div>
            <h3 className="font-bold text-gray-800">Fiche d'urgence</h3>
            <p className="text-xs text-gray-500">Ce qu'un secouriste voit en scannant le QR code, sans compte.</p>
          </div>
        </div>
        {data && <Badge variant={data.active ? "danger" : "default"}>{data.active ? "Activée" : "Désactivée"}</Badge>}
      </div>

      <div className="p-6">
        {loading && !data ? (
          <div className="flex justify-center py-8">
            <Loader2 className="animate-spin text-teal-600" size={28} />
          </div>
        ) : !data ? (
          <p className="text-sm text-gray-500 text-center py-6">Impossible de charger la fiche d'urgence.</p>
        ) : !canEdit ? (
          <div className="space-y-4">
            <p className="text-sm text-gray-600 bg-gray-50 rounded-xl p-4">
              La fiche d'urgence de {member.firstName} est <strong>{data.active ? "activée" : "désactivée"}</strong>. Seul le
              titulaire de la fiche la compose — ou, pour un proche sans compte (ou un adolescent), la personne qui gère son
              dossier.
            </p>
            {data.preview && (
              <div className="border border-gray-200 rounded-2xl p-4">
                <p className="text-xs font-bold uppercase tracking-wide text-gray-500 mb-3">Ce que voit un inconnu</p>
                <EmergencyView view={data.preview} />
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-6">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Compositeur */}
              <div className="space-y-4">
                <div className="bg-gray-50 rounded-xl p-4">
                  <Toggle
                    checked={draft.active}
                    onChange={(v) => setDraft((p) => ({ ...p, active: v }))}
                    label="Fiche d'urgence activée"
                  />
                  <p className="text-xs text-gray-500 mt-1">Désactivée, le QR code n'affiche plus rien.</p>
                </div>

                <div>
                  <p className="text-sm font-semibold text-gray-700 mb-2">Informations visibles</p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {EMERGENCY_FIELD_OPTIONS.map((f) => (
                      <label
                        key={f.key}
                        className="flex items-center gap-3 px-3 py-2.5 rounded-xl border border-gray-200 hover:border-teal-300 cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          className="w-4 h-4"
                          checked={!!draft.fields[f.key]}
                          onChange={(e) => setField(f.key, e.target.checked)}
                        />
                        <span className="text-sm text-gray-700">{f.label}</span>
                      </label>
                    ))}
                  </div>
                </div>

                <div>
                  <Textarea
                    label="Information utile en urgence"
                    placeholder="Ex. Diabétique, porte un pacemaker"
                    maxLength={EXTRA_INFO_MAX}
                    value={draft.extraInfo}
                    onChange={(e) => setDraft((p) => ({ ...p, extraInfo: e.target.value.slice(0, EXTRA_INFO_MAX) }))}
                  />
                  <p className="text-xs text-gray-400 text-right mt-1">
                    {draft.extraInfo.length} / {EXTRA_INFO_MAX}
                  </p>
                </div>

                {draft.active && nothingChecked && (
                  <p className="text-xs text-red-600">Cochez au moins une information avant d'activer la fiche d'urgence.</p>
                )}

                <div className="flex items-center gap-3 flex-wrap">
                  <Button onClick={save} loading={saving} disabled={!dirty && !!data.updatedAt}>
                    <Save size={15} />
                    Enregistrer
                  </Button>
                  {dirty && <span className="text-xs text-amber-600">Modifications non enregistrées</span>}
                  {!dirty && data.updatedAt && (
                    <span className="text-xs text-gray-400">Enregistrée le {formatDateTime(data.updatedAt)}</span>
                  )}
                </div>
              </div>

              {/* Aperçu en direct */}
              <div className="border-2 border-dashed border-red-200 rounded-2xl p-4 bg-red-50/30">
                <p className="text-xs font-bold uppercase tracking-wide text-red-700 mb-1 flex items-center gap-1.5">
                  <Eye size={14} /> Ce que verra un inconnu
                </p>
                <p className="text-xs text-gray-500 mb-3">
                  Aperçu en direct de vos réglages{dirty ? ", avant enregistrement" : ""}.
                </p>
                {draft.active ? (
                  <EmergencyView view={livePreview} preview />
                ) : (
                  <p className="text-sm text-gray-500 italic py-6 text-center">
                    Fiche désactivée : le QR code affichera « Fiche d'urgence introuvable ou désactivée ».
                  </p>
                )}
              </div>
            </div>

            {/* QR code, carte, image écran de verrouillage */}
            {published && (
              <div className="border-t border-gray-100 pt-6 flex flex-col sm:flex-row gap-6 items-center sm:items-start">
                <QrImage value={data.url} size={180} className="rounded-xl border border-gray-200 p-2" alt="QR code de la fiche d'urgence" />
                <div className="flex-1 space-y-3 w-full">
                  <p className="text-sm text-gray-600">
                    Imprimez la carte et glissez-la dans le portefeuille, ou mettez l'image en fond d'écran de verrouillage du
                    téléphone. Les informations y sont écrites en clair : elles restent lisibles sans réseau.
                  </p>
                  <div>
                    <p className="text-sm font-semibold text-gray-700 mb-1.5">Lien de la fiche d'urgence</p>
                    <div className="flex flex-col sm:flex-row gap-2">
                      <input
                        readOnly
                        value={data.url}
                        onFocus={(e) => e.target.select()}
                        className="flex-1 min-w-0 px-3 py-2 rounded-xl border border-gray-200 bg-gray-50 text-sm text-gray-700 font-mono"
                      />
                      <Button variant="outline" onClick={copyLink}>
                        <Copy size={15} />
                        Copier le lien
                      </Button>
                      <a
                        href={data.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-xl border border-gray-200 text-sm font-semibold text-gray-700 hover:bg-gray-50"
                      >
                        <ExternalLink size={15} />
                        Ouvrir
                      </a>
                    </div>
                    <p className="text-xs text-gray-400 mt-1">
                      Chaque ouverture, même la vôtre, est enregistrée et vous est signalée.
                    </p>
                  </div>
                  {dirty && (
                    <p className="text-xs text-amber-600">
                      La carte et l'image reprennent les réglages enregistrés : enregistrez d'abord vos modifications.
                    </p>
                  )}
                  <div className="flex flex-col sm:flex-row gap-2 flex-wrap">
                    <Button variant="outline" onClick={printCard}>
                      <Printer size={15} />
                      Imprimer la carte
                    </Button>
                    <Button variant="outline" onClick={downloadLockScreen} loading={imaging}>
                      <Smartphone size={15} />
                      Image pour l'écran de verrouillage
                    </Button>
                    <Button variant="ghost" className="text-red-600 hover:bg-red-50" onClick={regenerate} loading={regenerating}>
                      <RefreshCw size={15} />
                      Régénérer le QR code
                    </Button>
                  </div>
                </div>
                <EmergencyPrintCard view={data.preview} url={data.url} />
              </div>
            )}

            {/* Journal des consultations */}
            <div className="border-t border-gray-100 pt-6">
              <h4 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-1">Consultations de la fiche</h4>
              <p className="text-xs text-gray-500 mb-3 flex items-center gap-1.5">
                <Bell size={12} /> Chaque consultation vous est signalée.
              </p>
              {data.views?.length ? (
                <ul className="space-y-1.5">
                  {data.views.map((v, i) => (
                    <li key={i} className="text-sm text-gray-700 bg-gray-50 rounded-lg px-3 py-2">
                      Consultée le {formatDateTime(v.viewedAt)}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-gray-400 italic">Aucune consultation pour l'instant.</p>
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
