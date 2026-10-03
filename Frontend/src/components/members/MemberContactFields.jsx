import { Phone, Stethoscope, Siren } from "lucide-react";
import { Input } from "../ui/Input";

// Champs complémentaires de la fiche : coordonnées, médecin traitant et
// contact d'urgence. Tous optionnels (texte libre).
export const CONTACT_FIELDS_DEFAULTS = {
  phone: "",
  doctorName: "",
  doctorPhone: "",
  emergencyContactName: "",
  emergencyContactRelation: "",
  emergencyContactPhone: "",
};

// Valeurs du formulaire à partir d'une fiche existante (clés absentes si le
// dossier n'est pas lisible : on retombe sur une chaîne vide).
export function contactFieldsFromMember(m) {
  return Object.fromEntries(Object.keys(CONTACT_FIELDS_DEFAULTS).map((k) => [k, m?.[k] ?? ""]));
}

export function hasContactInfo(m) {
  return Object.keys(CONTACT_FIELDS_DEFAULTS).some((k) => m?.[k]);
}

function SectionTitle({ icon: Icon, children }) {
  return (
    <p className="text-xs font-bold text-gray-500 uppercase tracking-wide flex items-center gap-1.5">
      <Icon size={13} className="text-teal-500" />
      {children}
    </p>
  );
}

// Formulaire (création / modification d'une fiche).
export function MemberContactFields({ form, onChange }) {
  const f = (key) => (e) => onChange(key, e.target.value);
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <SectionTitle icon={Phone}>Coordonnées</SectionTitle>
        <Input label="Téléphone" type="tel" placeholder="+221 77 000 00 00" value={form.phone} onChange={f("phone")} />
      </div>

      <div className="space-y-2">
        <SectionTitle icon={Stethoscope}>Médecin traitant</SectionTitle>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Input label="Nom" placeholder="Dr. Diallo" value={form.doctorName} onChange={f("doctorName")} />
          <Input label="Téléphone" type="tel" placeholder="+221 33 000 00 00" value={form.doctorPhone} onChange={f("doctorPhone")} />
        </div>
      </div>

      <div className="space-y-2">
        <SectionTitle icon={Siren}>Contact d'urgence</SectionTitle>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Input label="Nom" placeholder="Aïssa Moussa" value={form.emergencyContactName} onChange={f("emergencyContactName")} />
          <Input
            label="Lien de parenté"
            placeholder="Sœur, Fils, Voisin..."
            value={form.emergencyContactRelation}
            onChange={f("emergencyContactRelation")}
          />
        </div>
        <Input
          label="Téléphone"
          type="tel"
          placeholder="+221 76 000 00 00"
          value={form.emergencyContactPhone}
          onChange={f("emergencyContactPhone")}
        />
      </div>
    </div>
  );
}

// Lien d'appel cliquable pour un numéro de téléphone.
function TelLink({ value }) {
  const href = `tel:${value.replace(/[^\d+]/g, "")}`;
  return (
    <a href={href} className="text-sm font-semibold text-teal-700 hover:underline inline-flex items-center gap-1">
      <Phone size={12} />
      {value}
    </a>
  );
}

// Affichage dans le détail d'une fiche (uniquement les blocs renseignés).
export function MemberContactDetails({ member }) {
  if (!hasContactInfo(member)) return null;
  const hasDoctor = member.doctorName || member.doctorPhone;
  const hasEmergency = member.emergencyContactName || member.emergencyContactRelation || member.emergencyContactPhone;

  return (
    <div>
      <h4 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-3">Contacts</h4>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {member.phone && (
          <div className="bg-gray-50 rounded-xl p-3">
            <p className="text-xs text-gray-400 font-medium">Téléphone</p>
            <TelLink value={member.phone} />
          </div>
        )}
        {hasDoctor && (
          <div className="bg-gray-50 rounded-xl p-3">
            <p className="text-xs text-gray-400 font-medium flex items-center gap-1">
              <Stethoscope size={11} /> Médecin traitant
            </p>
            {member.doctorName && <p className="text-sm font-semibold text-gray-700">{member.doctorName}</p>}
            {member.doctorPhone && <TelLink value={member.doctorPhone} />}
          </div>
        )}
        {hasEmergency && (
          <div className="bg-red-50/60 border border-red-100 rounded-xl p-3">
            <p className="text-xs text-red-500 font-medium flex items-center gap-1">
              <Siren size={11} /> Contact d'urgence
            </p>
            {(member.emergencyContactName || member.emergencyContactRelation) && (
              <p className="text-sm font-semibold text-gray-700">
                {member.emergencyContactName}
                {member.emergencyContactRelation && (
                  <span className="font-normal text-gray-500">
                    {member.emergencyContactName ? " · " : ""}
                    {member.emergencyContactRelation}
                  </span>
                )}
              </p>
            )}
            {member.emergencyContactPhone && <TelLink value={member.emergencyContactPhone} />}
          </div>
        )}
      </div>
    </div>
  );
}
