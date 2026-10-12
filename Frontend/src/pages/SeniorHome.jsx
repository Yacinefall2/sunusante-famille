import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { format, isToday, parseISO } from "date-fns";
import { Calendar, Check, Clock, HeartPulse, Loader2, MapPin, MoreHorizontal, Phone, Pill, ShieldPlus, Stethoscope, UserPlus, X } from "lucide-react";
import { AppShell } from "../components/layout/AppShell";
import { useAuth } from "../context/AuthContext";
import { useFamily } from "../context/FamilyContext";
import { NOTIFICATIONS_REFRESH_EVENT } from "../components/notifications/intakes";
import { BigIntakeButtons } from "../components/senior/BigIntakeButtons";
import { SoundAlertsSetup } from "../components/senior/SoundAlertsSetup";
import { cn } from "../lib/utils";

// ── Accueil du mode senior (UC-25, M10 Accessibilité) ───────────────────────
// Navigation simplifiée : une grande salutation puis de grandes tuiles, sur
// SA fiche uniquement (médicaments du jour, prochains rendez-vous, appel d'un
// proche, fiche d'urgence) ; « Plus » ouvre le tableau de bord habituel.

const capitalize = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
// « Lundi 12 octobre 2026 »
const longDate = (d) => capitalize(new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(d));
// « 10 h 30 »
const hourText = (hhmm) => {
  const [h, m] = hhmm.split(":");
  return `${Number(h)} h ${m}`;
};
const todayIso = () => format(new Date(), "yyyy-MM-dd");

// Prises du jour : celles déjà créées par le moteur de rappels (réponse
// possible), plus les heures encore à venir des traitements en cours.
function todaySchedule(intakes, treatments) {
  const done = intakes
    .filter((it) => isToday(parseISO(it.scheduledAt)))
    .map((it) => ({
      key: `i${it.id}`,
      time: format(parseISO(it.scheduledAt), "HH:mm"),
      name: it.medicationName,
      dosage: it.dosage,
      intake: it,
      medicationId: it.medicationId,
    }));
  const today = todayIso();
  const nowHm = format(new Date(), "HH:mm");
  const planned = [];
  for (const t of treatments) {
    if (!t.isActive || (t.startDate && t.startDate > today) || (t.endDate && t.endDate < today)) continue;
    for (const m of t.medications ?? []) {
      for (const time of m.intakeTimes ?? []) {
        if (done.some((d) => d.medicationId === m.id && d.time === time)) continue;
        // Une heure déjà passée sans rappel (traitement ajouté dans la journée,
        // par exemple) n'est pas « à venir ».
        planned.push({ key: `p${m.id}-${time}`, time, name: m.name, dosage: m.dosage, intake: null, past: time <= nowHm });
      }
    }
  }
  return [...done, ...planned].sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
}

function Tile({ icon: Icon, title, tone = "teal", children, className }) {
  const tones = {
    teal: "bg-teal-100 text-teal-800",
    violet: "bg-violet-100 text-violet-800",
    blue: "bg-blue-100 text-blue-800",
    red: "bg-red-100 text-red-800",
    gray: "bg-gray-200 text-gray-800",
  };
  return (
    <section className={cn("bg-white rounded-3xl border-2 border-gray-200 shadow-sm p-5 sm:p-6", className)}>
      <h3 className="flex items-center gap-3 text-2xl font-bold text-gray-900 mb-4">
        <span className={cn("w-14 h-14 rounded-2xl flex items-center justify-center flex-shrink-0", tones[tone])}>
          <Icon size={30} />
        </span>
        {title}
      </h3>
      {children}
    </section>
  );
}

function IntakeRow({ item }) {
  const status = item.intake?.status;
  return (
    <li className="py-4 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-2xl font-extrabold text-gray-900 tabular-nums">{hourText(item.time)}</span>
        <span className="text-xl font-bold text-gray-900">{item.name}</span>
        {item.dosage && <span className="text-lg text-gray-700">{item.dosage}</span>}
      </div>
      <div className="mt-3">
        {!item.intake && item.past ? (
          <p className="text-lg text-gray-700 flex items-center gap-2">
            <Clock size={22} /> Heure passée : pas de rappel pour cette prise aujourd'hui.
          </p>
        ) : !item.intake ? (
          <p className="text-lg text-gray-700 flex items-center gap-2">
            <Clock size={22} /> À venir : vous recevrez un rappel à l'heure.
          </p>
        ) : status === "pending" ? (
          <BigIntakeButtons intakeId={item.intake.id} />
        ) : status === "taken" ? (
          <p className="inline-flex items-center gap-2 text-xl font-bold text-emerald-800 bg-emerald-100 rounded-2xl px-4 py-3">
            <Check size={26} strokeWidth={3} /> Pris
          </p>
        ) : status === "not_taken" ? (
          <p className="inline-flex items-center gap-2 text-xl font-bold text-red-800 bg-red-100 rounded-2xl px-4 py-3">
            <X size={26} strokeWidth={3} /> Pas pris
          </p>
        ) : (
          <p className="inline-flex items-center gap-2 text-xl font-semibold text-gray-800 bg-gray-200 rounded-2xl px-4 py-3">
            Sans réponse
          </p>
        )}
      </div>
    </li>
  );
}

export default function SeniorHome() {
  const { user } = useAuth();
  const { selectedFamily, myMember, membersLoading } = useFamily();
  const [intakes, setIntakes] = useState([]);
  const [treatments, setTreatments] = useState([]);
  const [appointments, setAppointments] = useState([]);
  const [loading, setLoading] = useState(true);

  const memberId = myMember?.id ?? null;

  const load = useCallback(async () => {
    if (!memberId) {
      setLoading(false);
      return;
    }
    const get = async (url) => {
      try {
        const res = await fetch(url);
        const d = res.ok ? await res.json() : [];
        return Array.isArray(d) ? d : [];
      } catch {
        return [];
      }
    };
    const [i, t, a] = await Promise.all([
      get(`/api/intakes?memberId=${memberId}&days=1`),
      get(`/api/treatments?memberId=${memberId}`),
      get(`/api/appointments?memberId=${memberId}`),
    ]);
    setIntakes(i);
    setTreatments(t);
    setAppointments(a);
    setLoading(false);
  }, [memberId]);

  // Chargement, puis après chaque réponse à une prise ou nouvelle alerte.
  useEffect(() => {
    load();
    window.addEventListener(NOTIFICATIONS_REFRESH_EVENT, load);
    return () => window.removeEventListener(NOTIFICATIONS_REFRESH_EVENT, load);
  }, [load]);

  const firstName = myMember?.firstName || user?.name?.split(" ")[0] || "";
  const schedule = todaySchedule(intakes, treatments);
  const now = new Date();
  const nextAppointments = appointments
    .filter((a) => a.status !== "cancelled" && parseISO(a.appointmentDate) >= now)
    .sort((x, y) => (x.appointmentDate < y.appointmentDate ? -1 : 1))
    .slice(0, 3);

  return (
    <AppShell>
      <div className="max-w-3xl mx-auto space-y-6">
        <div>
          <h2 className="text-4xl font-extrabold text-gray-900">Bonjour {firstName}</h2>
          <p className="text-2xl text-gray-700 mt-1">{longDate(now)}</p>
          {selectedFamily && <p className="text-lg text-gray-600 mt-1">{selectedFamily.name}</p>}
        </div>

        <SoundAlertsSetup onlyIfDisabled />

        {!myMember ? (
          membersLoading ? (
            <div className="flex justify-center py-16">
              <Loader2 className="animate-spin text-teal-600" size={40} />
            </div>
          ) : (
            <Tile icon={HeartPulse} title="Ma fiche">
              <p className="text-xl text-gray-800 mb-4">Vous n'avez pas encore de fiche médicale à votre nom.</p>
              <Link
                to="/fiches"
                className="inline-flex items-center gap-3 min-h-[3.5rem] px-6 rounded-2xl bg-teal-600 hover:bg-teal-700 text-white text-xl font-bold"
              >
                <UserPlus size={26} /> Créer ma fiche
              </Link>
            </Tile>
          )
        ) : (
          <>
            <Tile icon={Pill} title="Mes médicaments du jour" tone="violet">
              {loading ? (
                <Loader2 className="animate-spin text-teal-600" size={32} />
              ) : schedule.length === 0 ? (
                <p className="text-xl text-gray-800">Aucun médicament prévu aujourd'hui.</p>
              ) : (
                <ul className="divide-y-2 divide-gray-200">
                  {schedule.map((item) => (
                    <IntakeRow key={item.key} item={item} />
                  ))}
                </ul>
              )}
            </Tile>

            <Tile icon={Calendar} title="Mes prochains rendez-vous" tone="blue">
              {loading ? (
                <Loader2 className="animate-spin text-teal-600" size={32} />
              ) : nextAppointments.length === 0 ? (
                <p className="text-xl text-gray-800">Aucun rendez-vous prévu.</p>
              ) : (
                <ul className="divide-y-2 divide-gray-200">
                  {nextAppointments.map((a) => {
                    const d = parseISO(a.appointmentDate);
                    return (
                      <li key={a.id} className="py-4 first:pt-0 last:pb-0 space-y-1">
                        <p className="text-2xl font-bold text-gray-900">
                          {longDate(d)} à {hourText(format(d, "HH:mm"))}
                        </p>
                        {a.title && <p className="text-xl text-gray-900">{a.title}</p>}
                        {a.location && (
                          <p className="text-lg text-gray-800 flex items-center gap-2">
                            <MapPin size={22} className="flex-shrink-0" /> {a.location}
                          </p>
                        )}
                        {a.doctorName && (
                          <p className="text-lg text-gray-800 flex items-center gap-2">
                            <Stethoscope size={22} className="flex-shrink-0" /> {a.doctorName}
                          </p>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </Tile>

            <Tile icon={Phone} title="Appeler un proche" tone="teal">
              {myMember.emergencyContactPhone ? (
                <a
                  href={`tel:${myMember.emergencyContactPhone.replace(/[^\d+]/g, "")}`}
                  className="flex items-center gap-4 min-h-[4.5rem] px-6 py-4 rounded-2xl bg-teal-600 hover:bg-teal-700 text-white focus:outline-none focus-visible:ring-4 focus-visible:ring-teal-300"
                >
                  <Phone size={34} className="flex-shrink-0" />
                  <span>
                    <span className="block text-2xl font-bold">
                      Appeler {myMember.emergencyContactName || "mon contact d'urgence"}
                    </span>
                    <span className="block text-xl">
                      {myMember.emergencyContactRelation ? `${myMember.emergencyContactRelation} · ` : ""}
                      {myMember.emergencyContactPhone}
                    </span>
                  </span>
                </a>
              ) : (
                <p className="text-xl text-gray-800">Aucun contact d'urgence : demandez à un proche de le renseigner.</p>
              )}
            </Tile>

            <Link
              to={`/partage?fiche=${myMember.id}`}
              className="flex items-center gap-4 bg-white rounded-3xl border-2 border-gray-200 shadow-sm p-5 sm:p-6 hover:border-red-300 focus:outline-none focus-visible:ring-4 focus-visible:ring-red-200"
            >
              <span className="w-14 h-14 rounded-2xl flex items-center justify-center flex-shrink-0 bg-red-100 text-red-800">
                <ShieldPlus size={30} />
              </span>
              <span>
                <span className="block text-2xl font-bold text-gray-900">Ma fiche d'urgence</span>
                <span className="block text-lg text-gray-700">À montrer aux secours : QR code et informations utiles</span>
              </span>
            </Link>
          </>
        )}

        <Link
          to="/dashboard?vue=complete"
          className="flex items-center gap-4 bg-white rounded-3xl border-2 border-gray-200 shadow-sm p-5 sm:p-6 hover:border-teal-300 focus:outline-none focus-visible:ring-4 focus-visible:ring-teal-200"
        >
          <span className="w-14 h-14 rounded-2xl flex items-center justify-center flex-shrink-0 bg-gray-200 text-gray-800">
            <MoreHorizontal size={30} />
          </span>
          <span>
            <span className="block text-2xl font-bold text-gray-900">Plus</span>
            <span className="block text-lg text-gray-700">Tout le reste : tableau de bord complet, famille, documents…</span>
          </span>
        </Link>
      </div>
    </AppShell>
  );
}
