import { useSearchParams } from "react-router-dom";
import { AppShell } from "../components/layout/AppShell";
import { useFamily } from "../context/FamilyContext";
import { Select } from "../components/ui/Input";
import { MemberAvatar } from "../components/members/MemberAvatar";
import { DoctorShareSection } from "../components/sharing/DoctorShareSection";
import { EmergencySection } from "../components/sharing/EmergencySection";
import { ShieldPlus, Loader2 } from "lucide-react";

// Page « Partage & urgence » (phase F) : lien temporaire pour un médecin et
// fiche d'urgence (QR code) d'une fiche lisible par l'utilisateur.
export default function PartagePage() {
  const { selectedFamily, members, myMember, membersLoading, canReadMember, canWriteMember, isDependent } = useFamily();
  const [searchParams, setSearchParams] = useSearchParams();

  const fiches = members.filter((m) => canReadMember(m.id));
  const requested = searchParams.get("fiche");
  const member =
    fiches.find((m) => String(m.id) === requested) ??
    (myMember && canReadMember(myMember.id) ? myMember : null) ??
    fiches[0] ??
    null;

  const selectFiche = (id) => setSearchParams({ fiche: id }, { replace: true });

  // Partage médecin : accès complet au dossier, ou sa propre fiche (hors adolescent)
  const canManageShares = member ? canWriteMember(member.id) || (member.isMine && !isDependent) : false;

  if (!selectedFamily) {
    return (
      <AppShell>
        <div className="text-center py-20 text-gray-400">
          <ShieldPlus size={48} className="mx-auto mb-3 opacity-30" />
          <p className="text-lg font-medium">Aucune famille sélectionnée</p>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
          <div>
            <h2 className="text-xl font-bold text-gray-800">Partage & urgence</h2>
            <p className="text-sm text-gray-500">
              Partagez un dossier avec un médecin, et préparez la fiche d'urgence lisible par un secouriste.
            </p>
          </div>
          {fiches.length > 0 && member && (
            <div className="sm:w-72">
              <Select label="Fiche" value={member.id} onChange={(e) => selectFiche(e.target.value)}>
                {fiches.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.firstName} {m.lastName}
                    {m.isMine ? " (ma fiche)" : ""}
                  </option>
                ))}
              </Select>
            </div>
          )}
        </div>

        {membersLoading && !member ? (
          <div className="flex justify-center py-20">
            <Loader2 className="animate-spin text-teal-600" size={36} />
          </div>
        ) : !member ? (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-16 text-center text-gray-400">
            <ShieldPlus size={40} className="mx-auto mb-3 opacity-40" />
            <p>Aucune fiche médicale à laquelle vous avez accès.</p>
          </div>
        ) : (
          <>
            <div className="bg-white rounded-2xl shadow-sm border border-gray-100 px-6 py-4">
              <MemberAvatar member={member} size="md" showName showAge />
            </div>
            <DoctorShareSection key={`share-${member.id}`} member={member} canManage={canManageShares} />
            <EmergencySection key={`urgence-${member.id}`} member={member} />
          </>
        )}
      </div>
    </AppShell>
  );
}
