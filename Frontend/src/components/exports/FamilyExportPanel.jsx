import { useCallback, useEffect, useState } from "react";
import { Archive, Loader2, Mail, ShieldAlert } from "lucide-react";
import toast from "react-hot-toast";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { formatDateTime } from "../../lib/utils";

// « Exporter les données de la famille » (UC-09) — réservé aux parents (A1, A2).
// Mot de passe redemandé ; l'archive est préparée par le serveur, puis un
// lien à usage unique, valable 1 heure, part par courriel. Le lien exige en
// plus d'être connecté avec ce compte. L'autre parent est prévenu.

const STATUS_LABELS = {
  pending: { label: "En préparation", className: "bg-amber-50 text-amber-700" },
  ready: { label: "Lien envoyé", className: "bg-teal-50 text-teal-700" },
  downloaded: { label: "Téléchargée", className: "bg-emerald-50 text-emerald-700" },
  expired: { label: "Lien expiré", className: "bg-gray-100 text-gray-500" },
  failed: { label: "Échec", className: "bg-red-50 text-red-600" },
};

const formatSize = (bytes) => {
  if (!bytes) return null;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(".", ",")} Mo`;
};

export function FamilyExportPanel({ familyId }) {
  const [history, setHistory] = useState({ exports: [], email: null, maxPerDay: 3 });
  const [loading, setLoading] = useState(true);
  const [acknowledged, setAcknowledged] = useState(false);
  const [password, setPassword] = useState("");
  const [sending, setSending] = useState(false);

  const load = useCallback(async () => {
    if (!familyId) return;
    try {
      const res = await fetch(`/api/families/${familyId}/exports`);
      const data = await res.json().catch(() => null);
      if (res.ok && data) setHistory(data);
    } finally {
      setLoading(false);
    }
  }, [familyId]);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  const pending = history.exports.find((e) => e.status === "pending");
  const lastReady = history.exports.find((e) => e.status === "ready");

  // Pendant la préparation : l'état est relu régulièrement.
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [pending, load]);

  const submit = async (e) => {
    e.preventDefault();
    setSending(true);
    try {
      const res = await fetch(`/api/families/${familyId}/export`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password, acknowledged }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error || "La demande d'export a échoué");
        return;
      }
      toast.success(data.message || "L'archive est en préparation");
      setPassword("");
      setAcknowledged(false);
      await load();
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
      <div className="px-6 py-4 border-b border-gray-100 flex items-center gap-2">
        <Archive size={16} className="text-teal-600" />
        <h3 className="font-bold text-gray-800 text-sm">Exporter les données de la famille</h3>
      </div>
      <div className="px-6 py-4 space-y-4">
        <div className="text-sm text-gray-600 space-y-2">
          <p>
            Une archive ZIP de tout ce que <strong>vous</strong> pouvez consulter dans l&apos;application :
          </p>
          <ul className="list-disc pl-5 space-y-0.5">
            <li>un dossier médical en PDF par personne (identité, traitements, vaccinations, rendez-vous, documents) ;</li>
            <li>les fichiers des documents médicaux, rangés par personne ;</li>
            <li>les données structurées (fichier JSON) et le journal d&apos;activité de la famille.</li>
          </ul>
          <p>
            Elle ne contient <strong>pas</strong> le dossier de l&apos;autre parent (sauf s&apos;il vous en a délégué
            l&apos;accès), ni les fiches archivées, ni les documents confidentiels réservés à leur titulaire, ni aucun mot de
            passe. L&apos;autre parent sera prévenu de cet export.
          </p>
          <p className="flex items-start gap-2 text-xs text-gray-500">
            <Mail size={14} className="flex-shrink-0 mt-0.5" />
            Le lien de téléchargement arrive par courriel{history.email ? ` à ${history.email}` : ""}. Il ne sert qu&apos;une
            fois, expire au bout d&apos;une heure et ne s&apos;ouvre qu&apos;une fois connecté à ce compte.
            {` Au plus ${history.maxPerDay} exports par 24 heures.`}
          </p>
        </div>

        {loading ? (
          <div className="flex justify-center py-4">
            <Loader2 className="animate-spin text-teal-600" size={22} />
          </div>
        ) : pending ? (
          <div className="flex items-center gap-3 bg-amber-50 border border-amber-200 rounded-xl p-3 text-sm text-amber-900">
            <Loader2 size={16} className="animate-spin flex-shrink-0" />
            <span>
              Archive en préparation (demandée le {formatDateTime(pending.createdAt)}). Vous recevrez le lien par courriel
              {history.email ? ` à ${history.email}` : ""}.
            </span>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-3">
            {lastReady && (
              <p className="text-sm text-teal-800 bg-teal-50 border border-teal-200 rounded-xl p-3">
                Lien envoyé à {history.email} — valable jusqu&apos;au {formatDateTime(lastReady.expiresAt)}. Une nouvelle
                demande annulera ce lien.
              </p>
            )}
            <label className="flex items-start gap-2 text-sm text-gray-700 cursor-pointer">
              <input
                type="checkbox"
                className="mt-1 accent-teal-600"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
              />
              <span className="flex items-start gap-1.5">
                <ShieldAlert size={15} className="text-amber-500 flex-shrink-0 mt-0.5" />
                Je comprends que cette archive contient des données de santé confidentielles
              </span>
            </label>
            <div className="flex flex-col sm:flex-row sm:items-end gap-3">
              <div className="flex-1">
                <Input
                  label="Votre mot de passe"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
              <Button type="submit" loading={sending} disabled={!acknowledged || !password}>
                <Archive size={15} />
                Préparer l&apos;archive
              </Button>
            </div>
          </form>
        )}

        {history.exports.length > 0 && (
          <div>
            <h4 className="text-xs font-bold text-gray-500 uppercase tracking-wide mb-2">Vos derniers exports</h4>
            <ul className="divide-y divide-gray-100 border border-gray-100 rounded-xl">
              {history.exports.map((e) => {
                const status = STATUS_LABELS[e.status] ?? { label: e.status, className: "bg-gray-100 text-gray-500" };
                return (
                  <li key={e.id} className="px-3 py-2 flex items-center gap-3 flex-wrap text-sm">
                    <span className="flex-1 min-w-[160px] text-gray-700">
                      Demandé le {formatDateTime(e.createdAt)}
                      {e.downloadedAt && <span className="text-gray-400"> · téléchargé le {formatDateTime(e.downloadedAt)}</span>}
                      {formatSize(e.sizeBytes) && <span className="text-gray-400"> · {formatSize(e.sizeBytes)}</span>}
                    </span>
                    <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${status.className}`}>{status.label}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
