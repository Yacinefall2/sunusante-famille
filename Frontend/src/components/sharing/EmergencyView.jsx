import { AlertTriangle, Droplets, Phone, Pill, Stethoscope, User, Info } from "lucide-react";
import { contactText, treatmentText } from "../../lib/partage";
import { cn } from "../../lib/utils";

// Affichage d'une vue d'urgence (forme publique). En mode aperçu, les champs
// cochés mais vides sont signalés « non renseigné sur la fiche ».
const Missing = ({ preview }) => (
  <span className={cn("text-sm italic", preview ? "text-amber-600" : "text-gray-400")}>
    {preview ? "Non renseigné sur la fiche" : "Non renseigné"}
  </span>
);

function CallButton({ phone, label }) {
  if (!phone) return null;
  return (
    <a
      href={`tel:${phone.replace(/\s+/g, "")}`}
      className="inline-flex items-center justify-center gap-2 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-xl px-4 py-3 text-base w-full sm:w-auto"
    >
      <Phone size={18} />
      {label} · {phone}
    </a>
  );
}

export function EmergencyView({ view, preview = false, large = false }) {
  if (!view) return null;
  const hasAny =
    "age" in view ||
    "bloodType" in view ||
    "allergies" in view ||
    "treatments" in view ||
    "emergencyContact" in view ||
    "doctor" in view ||
    !!view.extraInfo;
  const contact = view.emergencyContact;
  const doctor = view.doctor;
  const contactWho = contact && [contact.name, contact.relation && `(${contact.relation})`].filter(Boolean).join(" ");
  const doctorWho = doctor?.name;

  return (
    <div className="space-y-4">
      <div>
        <p className={cn("font-extrabold text-gray-900 leading-tight", large ? "text-4xl sm:text-5xl" : "text-2xl")}>
          {view.firstName} {view.lastName}
        </p>
        {"age" in view && (
          <p className={cn("text-gray-600 mt-1", large ? "text-xl" : "text-sm")}>
            {view.age != null ? `${view.age} ans` : <Missing preview={preview} />}
          </p>
        )}
      </div>

      {"bloodType" in view && (
        <div className="flex items-center gap-4 bg-red-50 border-2 border-red-200 rounded-2xl p-4">
          <Droplets className="text-red-600 flex-shrink-0" size={large ? 40 : 28} />
          <div>
            <p className="text-xs font-bold uppercase tracking-wide text-red-700">Groupe sanguin</p>
            {view.bloodType ? (
              <p className={cn("font-black text-red-700 leading-none", large ? "text-7xl" : "text-4xl")}>{view.bloodType}</p>
            ) : (
              <Missing preview={preview} />
            )}
          </div>
        </div>
      )}

      {"allergies" in view && (
        <div className={cn("rounded-2xl p-4 border-2", view.allergies ? "bg-red-600 border-red-700 text-white" : "bg-gray-50 border-gray-200")}>
          <p className={cn("text-xs font-bold uppercase tracking-wide flex items-center gap-1.5", view.allergies ? "text-red-100" : "text-gray-600")}>
            <AlertTriangle size={14} /> Allergies
          </p>
          {view.allergies ? (
            <p className={cn("font-bold mt-1", large ? "text-2xl" : "text-lg")}>{view.allergies}</p>
          ) : (
            <Missing preview={preview} />
          )}
        </div>
      )}

      {view.extraInfo && (
        <div className="rounded-2xl p-4 bg-amber-50 border-2 border-amber-300">
          <p className="text-xs font-bold uppercase tracking-wide text-amber-800 flex items-center gap-1.5">
            <Info size={14} /> Information utile
          </p>
          <p className={cn("font-semibold text-amber-900 mt-1 whitespace-pre-wrap", large ? "text-xl" : "text-base")}>{view.extraInfo}</p>
        </div>
      )}

      {"treatments" in view && (
        <div className="rounded-2xl p-4 bg-violet-50 border border-violet-200">
          <p className="text-xs font-bold uppercase tracking-wide text-violet-800 flex items-center gap-1.5">
            <Pill size={14} /> Traitements en cours
          </p>
          {view.treatments?.length ? (
            <ul className={cn("mt-1 space-y-1 text-gray-800", large ? "text-lg" : "text-sm")}>
              {view.treatments.map((t, i) => (
                <li key={i}>• {treatmentText(t)}</li>
              ))}
            </ul>
          ) : (
            <p>{preview ? <Missing preview /> : <span className="text-sm text-gray-500">Aucun traitement en cours</span>}</p>
          )}
        </div>
      )}

      {"emergencyContact" in view && (
        <div className="rounded-2xl p-4 bg-white border border-gray-200 space-y-2">
          <p className="text-xs font-bold uppercase tracking-wide text-gray-600 flex items-center gap-1.5">
            <User size={14} /> Personne à prévenir
          </p>
          {contactText(contact) ? (
            <>
              {contactWho && <p className={cn("font-semibold text-gray-800", large ? "text-lg" : "text-sm")}>{contactWho}</p>}
              {preview ? (
                contact.phone && <p className="text-sm text-gray-700">{contact.phone}</p>
              ) : (
                <CallButton phone={contact.phone} label="Appeler" />
              )}
            </>
          ) : (
            <Missing preview={preview} />
          )}
        </div>
      )}

      {"doctor" in view && (
        <div className="rounded-2xl p-4 bg-white border border-gray-200 space-y-2">
          <p className="text-xs font-bold uppercase tracking-wide text-gray-600 flex items-center gap-1.5">
            <Stethoscope size={14} /> Médecin traitant
          </p>
          {contactText(doctor) ? (
            <>
              {doctorWho && <p className={cn("font-semibold text-gray-800", large ? "text-lg" : "text-sm")}>{doctorWho}</p>}
              {preview ? (
                doctor.phone && <p className="text-sm text-gray-700">{doctor.phone}</p>
              ) : (
                <CallButton phone={doctor.phone} label="Appeler le médecin" />
              )}
            </>
          ) : (
            <Missing preview={preview} />
          )}
        </div>
      )}

      {!hasAny && <p className="text-sm text-gray-400 italic">Seuls le prénom et le nom sont affichés.</p>}
    </div>
  );
}
