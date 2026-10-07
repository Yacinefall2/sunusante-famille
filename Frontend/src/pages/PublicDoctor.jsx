import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { Heart, Loader2, Printer, Droplets, AlertTriangle, Stethoscope, Pill, Syringe, FileText, ExternalLink, Lock, ShieldX, Download } from "lucide-react";
import { DOCUMENT_TYPES, formatDate, formatDateTime } from "../lib/utils";
import { downloadDoctorPdf } from "../lib/doctorPdf";
import toast from "react-hot-toast";

// Vue publique, en lecture seule, du dossier partagé avec un professionnel
// de santé (lien à usage unique). Accessible sans compte.

const ERRORS = {
  already_opened: {
    title: "Lien déjà utilisé",
    text: "Ce lien a déjà été ouvert sur un autre appareil. Pour votre sécurité, il ne peut servir qu'une fois. Demandez un nouveau lien à la famille.",
  },
  expired: {
    title: "Lien expiré",
    text: "La durée de validité de ce lien est dépassée. Demandez un nouveau lien à la famille.",
  },
  revoked: {
    title: "Lien révoqué",
    text: "La famille a révoqué ce lien : le dossier n'est plus accessible. Demandez-lui un nouveau lien si nécessaire.",
  },
  unknown: {
    title: "Lien introuvable",
    text: "Ce lien n'existe pas ou est incomplet. Vérifiez l'adresse reçue, ou demandez un nouveau lien à la famille.",
  },
  network: {
    title: "Chargement impossible",
    text: "Le dossier n'a pas pu être chargé. Vérifiez votre connexion Internet puis rechargez la page.",
  },
};

const genderLabel = (g) => (g === "M" ? "Homme" : g === "F" ? "Femme" : null);
const docTypeLabel = (t) => DOCUMENT_TYPES.find((d) => d.value === t)?.label ?? t;

function Section({ icon: Icon, title, children }) {
  return (
    <section className="bg-white rounded-2xl border border-gray-200 p-5 print:border-gray-400 print:rounded-none print:p-3 break-inside-avoid">
      <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-3 flex items-center gap-2">
        <Icon size={16} className="text-teal-600 print:hidden" />
        {title}
      </h2>
      {children}
    </section>
  );
}

const Empty = ({ children }) => <p className="text-sm text-gray-400 italic">{children}</p>;

export default function PublicDoctorPage() {
  const { token } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  // Un seul appel au chargement : le lien est à usage unique (garde contre
  // le double montage de React.StrictMode en développement).
  const requested = useRef(false);
  const [exporting, setExporting] = useState(false);

  const exportPdf = async () => {
    setExporting(true);
    try {
      await downloadDoctorPdf(data);
    } catch (e) {
      console.error(e);
      toast.error("Le PDF n'a pas pu être généré");
    } finally {
      setExporting(false);
    }
  };

  useEffect(() => {
    if (requested.current) return;
    requested.current = true;
    (async () => {
      try {
        const res = await fetch(`/api/public/doctor/${encodeURIComponent(token)}`, { credentials: "include" });
        if (res.ok) {
          setData(await res.json());
          return;
        }
        const body = await res.json().catch(() => ({}));
        setError(res.status === 404 ? "unknown" : ERRORS[body.reason] ? body.reason : "unknown");
      } catch {
        setError("network");
      }
    })();
  }, [token]);

  useEffect(() => {
    document.title = "Dossier partagé — SunuSanté Famille";
  }, []);

  const header = (
    <header className="bg-gradient-to-r from-teal-600 to-blue-600 text-white print:bg-none print:text-black print:border-b-2 print:border-black">
      <div className="max-w-3xl mx-auto px-4 py-4 flex items-center gap-3">
        <div className="w-9 h-9 bg-white/20 rounded-xl flex items-center justify-center print:hidden">
          <Heart size={18} />
        </div>
        <p className="font-bold text-base sm:text-lg">Dossier partagé par la famille — SunuSanté Famille</p>
      </div>
    </header>
  );

  if (!data && !error) {
    return (
      <div className="min-h-screen bg-gray-50">
        {header}
        <div className="flex justify-center py-24">
          <Loader2 className="animate-spin text-teal-600" size={40} />
        </div>
      </div>
    );
  }

  if (error) {
    const e = ERRORS[error];
    return (
      <div className="min-h-screen bg-gray-50">
        {header}
        <div className="max-w-lg mx-auto px-4 py-16">
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-8 text-center">
            <div className="w-16 h-16 bg-red-50 rounded-2xl flex items-center justify-center mx-auto mb-4">
              <ShieldX size={32} className="text-red-500" />
            </div>
            <h1 className="text-xl font-bold text-gray-800 mb-2">{e.title}</h1>
            <p className="text-gray-600">{e.text}</p>
          </div>
        </div>
      </div>
    );
  }

  const { member, essentials, treatments, vaccinations, documents } = data;
  const gender = genderLabel(member.gender);

  return (
    <div className="min-h-screen bg-gray-50 print:bg-white">
      {header}
      <main className="max-w-3xl mx-auto px-4 py-6 space-y-4 print:py-2 print:space-y-3">
        {/* Identité */}
        <section className="bg-white rounded-2xl border border-gray-200 p-5 print:border-0 print:p-0">
          <h1 className="text-2xl sm:text-3xl font-extrabold text-gray-900">
            {member.firstName} {member.lastName}
          </h1>
          <p className="text-gray-600 mt-1">
            {member.age != null && <span>{member.age} ans</span>}
            {member.dateOfBirth && <span> · né(e) le {formatDate(member.dateOfBirth)}</span>}
            {gender && <span> · {gender}</span>}
          </p>
          <p className="mt-3 inline-flex items-center gap-1.5 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-1.5 print:bg-transparent print:border-0 print:px-0">
            <Lock size={13} className="print:hidden" />
            Accès valable jusqu'au {formatDateTime(data.expiresAt)} — lecture seule
          </p>
          <div className="mt-4 flex flex-wrap gap-2 print:hidden">
            <button
              onClick={() => window.print()}
              className="inline-flex items-center gap-2 bg-white border border-teal-600 text-teal-700 hover:bg-teal-50 font-semibold rounded-xl px-4 py-2.5 text-sm"
            >
              <Printer size={16} />
              Imprimer
            </button>
            <button
              onClick={exportPdf}
              disabled={exporting}
              className="inline-flex items-center gap-2 bg-teal-600 hover:bg-teal-700 disabled:opacity-60 text-white font-semibold rounded-xl px-4 py-2.5 text-sm shadow-sm"
            >
              {exporting ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
              Télécharger en PDF
            </button>
          </div>
        </section>

        {essentials && (
          <Section icon={Stethoscope} title="Essentiel">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="bg-red-50 rounded-xl p-3 print:bg-transparent print:p-0">
                <p className="text-xs text-gray-500 font-medium flex items-center gap-1">
                  <Droplets size={12} className="print:hidden" /> Groupe sanguin
                </p>
                <p className="text-xl font-bold text-red-700 print:text-black">{essentials.bloodType || "Non renseigné"}</p>
              </div>
              <div className="bg-gray-50 rounded-xl p-3 print:bg-transparent print:p-0">
                <p className="text-xs text-gray-500 font-medium">Médecin traitant</p>
                <p className="text-sm font-semibold text-gray-800">{essentials.doctorName || "Non renseigné"}</p>
                {essentials.doctorPhone && (
                  <a href={`tel:${essentials.doctorPhone.replace(/\s+/g, "")}`} className="text-sm text-teal-700 hover:underline">
                    {essentials.doctorPhone}
                  </a>
                )}
              </div>
              <div className="sm:col-span-2 bg-amber-50 border border-amber-200 rounded-xl p-3 print:bg-transparent print:border-0 print:p-0">
                <p className="text-xs text-amber-800 font-medium flex items-center gap-1">
                  <AlertTriangle size={12} className="print:hidden" /> Allergies
                </p>
                <p className="text-sm font-semibold text-gray-800 whitespace-pre-wrap">{essentials.allergies || "Aucune allergie renseignée"}</p>
              </div>
            </div>
          </Section>
        )}

        {treatments && (
          <Section icon={Pill} title="Traitements en cours">
            {treatments.length === 0 ? (
              <Empty>Aucun traitement en cours.</Empty>
            ) : (
              <div className="space-y-3">
                {treatments.map((t, i) => (
                  <div key={i} className="border-l-4 border-violet-300 pl-3 print:border-gray-500">
                    <p className="font-semibold text-gray-800">{t.disease}</p>
                    <p className="text-xs text-gray-500">
                      {t.startDate && `Depuis le ${formatDate(t.startDate)}`}
                      {t.endDate && ` · jusqu'au ${formatDate(t.endDate)}`}
                      {t.prescribedBy && ` · prescrit par ${t.prescribedBy}`}
                    </p>
                    {t.medications?.length > 0 && (
                      <ul className="mt-1 space-y-0.5 text-sm text-gray-700">
                        {t.medications.map((m, j) => (
                          <li key={j}>
                            • <span className="font-medium">{m.name}</span>
                            {m.dosage && ` — ${m.dosage}`}
                            {m.frequency && ` — ${m.frequency}`}
                            {Array.isArray(m.intakeTimes) && m.intakeTimes.length > 0 && ` (${m.intakeTimes.join(", ")})`}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Section>
        )}

        {vaccinations && (
          <Section icon={Syringe} title="Vaccinations">
            {vaccinations.length === 0 ? (
              <Empty>Aucune vaccination enregistrée.</Empty>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-gray-500 border-b border-gray-200">
                      <th className="py-2 pr-3 font-semibold">Vaccin</th>
                      <th className="py-2 pr-3 font-semibold">Date</th>
                      <th className="py-2 pr-3 font-semibold">Rappel</th>
                      <th className="py-2 pr-3 font-semibold">Administré par</th>
                      <th className="py-2 font-semibold">Lot</th>
                    </tr>
                  </thead>
                  <tbody>
                    {vaccinations.map((v, i) => (
                      <tr key={i} className="border-b border-gray-100 last:border-0">
                        <td className="py-2 pr-3 font-medium text-gray-800">{v.vaccineName}</td>
                        <td className="py-2 pr-3 text-gray-700">{formatDate(v.dateAdministered)}</td>
                        <td className="py-2 pr-3 text-gray-700">{v.nextDoseDate ? formatDate(v.nextDoseDate) : "—"}</td>
                        <td className="py-2 pr-3 text-gray-700">{v.administeredBy || "—"}</td>
                        <td className="py-2 text-gray-700">{v.lotNumber || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>
        )}

        {documents && (
          <Section icon={FileText} title="Documents">
            {documents.length === 0 ? (
              <Empty>Aucun document disponible.</Empty>
            ) : (
              <div className="space-y-2">
                {documents.map((d) => (
                  <div key={d.id} className="flex items-start justify-between gap-3 bg-gray-50 rounded-xl p-3 print:bg-transparent print:p-0">
                    <div className="min-w-0">
                      <p className="font-semibold text-gray-800">{d.title}</p>
                      <p className="text-xs text-gray-500">
                        {docTypeLabel(d.documentType)}
                        {d.uploadedAt && ` · ajouté le ${formatDate(d.uploadedAt)}`}
                        {d.originalName && ` · ${d.originalName}`}
                      </p>
                      {d.description && <p className="text-sm text-gray-600 mt-1">{d.description}</p>}
                    </div>
                    {d.hasFile && (
                      <a
                        href={`/api/public/doctor/${encodeURIComponent(token)}/documents/${d.id}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 text-sm font-semibold text-teal-700 hover:underline flex-shrink-0 print:hidden"
                      >
                        <ExternalLink size={14} />
                        Ouvrir
                      </a>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Section>
        )}

        <p className="text-xs text-gray-400 text-center pt-2">
          Document confidentiel transmis par la famille via SunuSanté Famille — consulté le {formatDateTime(new Date())}.
        </p>
      </main>
    </div>
  );
}
