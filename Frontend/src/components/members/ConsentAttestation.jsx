import { useEffect, useState } from "react";
import { format, subYears } from "date-fns";
import { CheckCircle2, HandHeart, PenLine, Phone, ShieldAlert, Users } from "lucide-react";
import toast from "react-hot-toast";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { useAuth } from "../../context/AuthContext";
import { useFamily } from "../../context/FamilyContext";
import { calculateAge, cn, formatDate, formatDateTime } from "../../lib/utils";

// ── Attestation du consentement oral d'un proche majeur (UC-29, écran n°6) ──
// Étape BLOQUANTE à la création du dossier d'un proche majeur sans compte, et
// même écran pour attester une fiche existante ou réactiver une fiche dont le
// proche avait retiré son accord. C'est un ENGAGEMENT signé, pas une case à
// cocher : le déclarant relit ce qu'il doit avoir dit au proche, indique
// comment et quand l'accord a été obtenu, puis signe en retapant son nom.
// Le serveur vérifie tout de nouveau (Backend/src/lib/consent.js).

// Version du texte d'engagement (même valeur que CONSENT_TEXT_VERSION côté
// serveur) : à changer avec le texte ci-dessous.
export const CONSENT_TEXT_VERSION = "2026-10-v1";

export const CONSENT_METHODS = [
  { value: "en_personne", label: "En personne", hint: "Vous lui avez parlé face à face", icon: HandHeart },
  { value: "telephone", label: "Par téléphone", hint: "Vous l'avez appelé(e)", icon: Phone },
  { value: "intermediaire", label: "Par l'intermédiaire d'un proche", hint: "Un proche lui a parlé pour vous", icon: Users },
];
const METHOD_TEXT = { en_personne: "en personne", telephone: "par téléphone", intermediaire: "par l'intermédiaire d'un proche" };

// L'attestation s'applique-t-elle ? Proche de 18 ans ou plus, ou âge inconnu.
export const consentApplies = (dateOfBirth) => {
  const age = calculateAge(dateOfBirth || null);
  return age === null || age >= 18;
};

// Même comparaison que le serveur : sans accents, casse ni espaces multiples.
export const normalizeName = (v) =>
  String(v ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

// « Accord oral attesté par X le 12/10/2026 à 10:42 (en personne, accord du 10/10/2026) »
export function consentSummary(attestation) {
  if (!attestation) return "";
  const how = METHOD_TEXT[attestation.method] ?? "";
  const via = attestation.method === "intermediaire" && attestation.intermediaryName ? ` (${attestation.intermediaryName})` : "";
  return (
    `Accord oral attesté par ${attestation.declarantName} le ${formatDateTime(attestation.attestedAt)}` +
    ` (${how}${via}, accord du ${formatDate(attestation.obtainedAt)})`
  );
}

const today = () => format(new Date(), "yyyy-MM-dd");
const oneYearAgo = () => format(subYears(new Date(), 1), "yyyy-MM-dd");

// Contenu de l'écran d'engagement. `member` : { firstName, lastName }.
// `onSubmit(attestation)` envoie l'attestation ({ method, intermediaryName,
// obtainedOn, signedName }) ; `onBack` revient en arrière (libellé `backLabel`).
export function ConsentAttestation({ member, onSubmit, onBack, backLabel = "Retour", submitting = false, error = "" }) {
  const { user } = useAuth();
  const [method, setMethod] = useState("");
  const [intermediaryName, setIntermediaryName] = useState("");
  const [obtainedOn, setObtainedOn] = useState(today());
  const [signedName, setSignedName] = useState("");

  const fullName = `${member.firstName} ${member.lastName}`.trim();
  const accountName = user?.name ?? "";
  const signed = signedName.trim() !== "";
  const signatureOk = signed && normalizeName(signedName) === normalizeName(accountName);

  const problem = !method
    ? "Indiquez comment l'accord a été obtenu."
    : method === "intermediaire" && !intermediaryName.trim()
      ? "Indiquez le nom du proche qui a recueilli l'accord."
      : !obtainedOn || obtainedOn > today()
        ? "La date de l'accord ne peut pas être dans le futur."
        : obtainedOn < oneYearAgo()
          ? "L'accord date de plus d'un an : redemandez-le au proche avant d'attester."
          : !signatureOk
            ? "Signez en retapant votre nom complet."
            : null;

  const submit = (e) => {
    e?.preventDefault();
    if (problem) {
      toast.error(problem);
      return;
    }
    onSubmit({ method, intermediaryName: method === "intermediaire" ? intermediaryName.trim() : "", obtainedOn, signedName: signedName.trim() });
  };

  return (
    <form onSubmit={submit} className="space-y-5">
      {/* 1. Ce que le déclarant doit avoir dit au proche */}
      <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 space-y-3">
        <p className="flex items-start gap-2 text-sm font-semibold text-amber-900">
          <ShieldAlert size={18} className="flex-shrink-0 mt-0.5" />
          <span>
            {fullName} est majeur(e) : son dossier médical ne peut être suivi ici qu&apos;avec son accord. Vous devez le lui
            avoir demandé et lui avoir expliqué :
          </span>
        </p>
        <ul className="space-y-2 text-sm text-amber-900 pl-1">
          <li>
            <strong>Ce qui sera suivi</strong> : ses rendez-vous médicaux, ses traitements, ses vaccins et ses documents
            médicaux.
          </li>
          <li>
            <strong>Qui y aura accès</strong> : les gestionnaires de son dossier et les parents (administrateurs) de la
            famille. Les relais ne voient que la date, l&apos;heure et le lieu de ses rendez-vous, rien d&apos;autre.
          </li>
          <li>
            <strong>Qu&apos;il ou elle peut retirer son accord à tout moment</strong> : il suffit de le dire à la famille,
            et sa fiche sera archivée — plus personne n&apos;y aura accès.
          </li>
        </ul>
      </div>

      {/* 2. Comment et quand l'accord a été obtenu */}
      <fieldset className="space-y-2">
        <legend className="text-sm font-semibold text-gray-700 mb-2">Comment avez-vous obtenu son accord ? *</legend>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          {CONSENT_METHODS.map(({ value, label, hint, icon: Icon }) => (
            <label
              key={value}
              className={cn(
                "flex sm:flex-col items-start gap-2 rounded-xl border-2 p-3 cursor-pointer transition-colors",
                method === value ? "border-teal-600 bg-teal-50" : "border-gray-200 hover:border-gray-300"
              )}
            >
              <input
                type="radio"
                name="consent-method"
                value={value}
                checked={method === value}
                onChange={() => setMethod(value)}
                className="sr-only"
              />
              <Icon size={18} className={method === value ? "text-teal-700" : "text-gray-400"} />
              <span>
                <span className="block text-sm font-semibold text-gray-800">{label}</span>
                <span className="block text-xs text-gray-500">{hint}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      {method === "intermediaire" && (
        <Input
          label="Nom du proche qui a recueilli son accord *"
          placeholder="Prénom et nom"
          maxLength={150}
          value={intermediaryName}
          onChange={(e) => setIntermediaryName(e.target.value)}
        />
      )}
      <Input
        type="date"
        label="Date de l'accord *"
        value={obtainedOn}
        min={oneYearAgo()}
        max={today()}
        onChange={(e) => setObtainedOn(e.target.value)}
      />

      {/* 3. L'engagement, puis la signature */}
      <blockquote className="border-l-4 border-teal-600 bg-gray-50 rounded-r-xl px-4 py-3 text-sm sm:text-base text-gray-800 italic">
        « J&apos;atteste sur l&apos;honneur avoir obtenu l&apos;accord oral de <strong className="not-italic">{fullName}</strong>{" "}
        pour que son dossier médical soit suivi dans SunuSanté Famille, dans les conditions ci-dessus. »
      </blockquote>
      <div className="space-y-1.5">
        <Input
          label="Votre signature : retapez votre nom complet *"
          placeholder={accountName}
          autoComplete="off"
          maxLength={150}
          value={signedName}
          onChange={(e) => setSignedName(e.target.value)}
          error={signed && !signatureOk ? `La signature doit être votre nom tel qu'il figure sur votre compte : « ${accountName} »` : undefined}
        />
        {signatureOk ? (
          <p className="flex items-center gap-1.5 text-xs text-emerald-700">
            <CheckCircle2 size={13} /> Signature conforme au nom de votre compte
          </p>
        ) : (
          !signed && (
            <p className="flex items-center gap-1.5 text-xs text-gray-500">
              <PenLine size={13} /> Votre nom, tel qu&apos;il figure sur votre compte : {accountName}
            </p>
          )
        )}
        <p className="text-xs text-gray-400">
          La date, l&apos;heure et votre identité seront enregistrées avec cet engagement, consultable dans le journal
          d&apos;activité.
        </p>
      </div>

      {error && <p className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-xl px-3 py-2">{error}</p>}

      <div className="flex flex-col-reverse sm:flex-row gap-3 pt-2">
        {onBack && (
          <Button type="button" variant="ghost" onClick={onBack} className="sm:flex-1">
            {backLabel}
          </Button>
        )}
        <Button type="submit" loading={submitting} disabled={!!problem} className="sm:flex-1">
          Je m&apos;engage et j&apos;atteste
        </Button>
      </div>
      <p className="text-[11px] text-gray-400 text-center">Texte d&apos;engagement, version {CONSENT_TEXT_VERSION}</p>
    </form>
  );
}

// Attester une fiche EXISTANTE, ou réactiver une fiche archivée parce que le
// proche avait retiré son accord (`renewal`) : POST /api/members/:id/consent.
export function ConsentAttestationModal({ open, onClose, member, renewal = false, onDone }) {
  const { reloadMembers } = useFamily();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (open) setError("");
  }, [open]);

  if (!member) return null;

  const submit = async (attestation) => {
    setSubmitting(true);
    setError("");
    try {
      const res = await fetch(`/api/members/${member.id}/consent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(attestation),
      });
      if (res.ok) {
        toast.success(renewal ? "Fiche réactivée : vous en êtes gestionnaire" : "Accord oral attesté");
        onClose();
        await reloadMembers();
        onDone?.();
      } else {
        const err = await res.json().catch(() => ({}));
        setError(err.error || "L'attestation n'a pas pu être enregistrée");
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={renewal ? `${member.firstName} redonne son accord` : `Accord de ${member.firstName} ${member.lastName}`}
      description="Engagement sur l'honneur : accord oral du proche pour le suivi de son dossier médical"
      size="lg"
    >
      {renewal && (
        <p className="text-sm text-gray-600 bg-teal-50 border border-teal-100 rounded-xl px-3 py-2 mb-4">
          La fiche sera réactivée et vous en deviendrez gestionnaire. Les rôles donnés avant le retrait ne sont pas rétablis.
        </p>
      )}
      <ConsentAttestation member={member} onSubmit={submit} onBack={onClose} backLabel="Annuler" submitting={submitting} error={error} />
    </Modal>
  );
}

// Le proche retire son accord : confirmation explicite des conséquences, puis
// POST /api/members/:id/consent/withdraw (la fiche est archivée).
export function ConsentWithdrawModal({ open, onClose, member, onDone }) {
  const { reloadMembers } = useFamily();
  const [submitting, setSubmitting] = useState(false);
  if (!member) return null;

  const withdraw = async () => {
    setSubmitting(true);
    try {
      const res = await fetch(`/api/members/${member.id}/consent/withdraw`, { method: "POST" });
      if (res.ok) {
        toast.success(`Retrait enregistré : la fiche de ${member.firstName} est archivée`);
        onClose();
        await reloadMembers();
        onDone?.();
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || "Le retrait n'a pas pu être enregistré");
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={`${member.firstName} retire son accord`} size="md">
      <div className="space-y-4">
        <p className="text-sm text-gray-700">
          Vous allez enregistrer que <strong>{`${member.firstName} ${member.lastName}`}</strong> ne souhaite plus que son
          dossier médical soit suivi dans l&apos;application. Dès la confirmation :
        </p>
        <ul className="list-disc pl-5 space-y-1.5 text-sm text-gray-700">
          <li>sa fiche est archivée : plus personne n&apos;y a accès, vous non plus, ni les parents ;</li>
          <li>tous les rôles sur son dossier (gestionnaires, relais, lecteurs) sont retirés ;</li>
          <li>les rappels et le Village s&apos;arrêtent, les liens médecin sont révoqués et sa fiche d&apos;urgence est désactivée.</li>
        </ul>
        <p className="text-sm text-gray-600 bg-gray-50 rounded-xl px-3 py-2">
          Ses données ne sont pas effacées. Si {member.firstName} redonne un jour son accord, un parent pourra réactiver sa
          fiche avec une nouvelle attestation. Le retrait est inscrit au journal d&apos;activité, à votre nom.
        </p>
        <div className="flex flex-col-reverse sm:flex-row gap-3 pt-2">
          <Button type="button" variant="ghost" onClick={onClose} className="sm:flex-1">
            Annuler
          </Button>
          <Button type="button" variant="danger" onClick={withdraw} loading={submitting} className="sm:flex-1">
            Confirmer le retrait et archiver
          </Button>
        </div>
      </div>
    </Modal>
  );
}

