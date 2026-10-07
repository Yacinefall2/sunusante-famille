import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { addDays, format, parseISO } from "date-fns";
import { fr } from "date-fns/locale";
import toast from "react-hot-toast";
import {
  Activity,
  AlertTriangle,
  BellRing,
  Calendar,
  CalendarCheck,
  CalendarPlus,
  CheckCircle2,
  ChevronRight,
  ClipboardPen,
  Clock,
  FileText,
  HandHeart,
  Info,
  Lock,
  Mail,
  MapPin,
  Package,
  Pill,
  RefreshCw,
  Stethoscope,
  Syringe,
  UserPlus,
  Users,
} from "lucide-react";
import { AppShell } from "../components/layout/AppShell";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { useFamily } from "../context/FamilyContext";
import { useAuth } from "../context/AuthContext";
import { kinshipLabel } from "../lib/kinship";
import { cn, formatDate, formatTimeAgo } from "../lib/utils";
import {
  IntakeStatusBadge,
  NOTIFICATIONS_REFRESH_EVENT,
  notifyNotificationsChanged,
  respondIntake,
} from "../components/notifications/intakes";

// ---------------------------------------------------------------------------
// Tableau de bord des Parents (administrateurs) : vue d'ensemble de la famille.
// Les autres membres conservent le tableau de bord classique (Dashboard.jsx).
// Données : GET /api/dashboard/family?familyId=X (réservé aux parents).
// ---------------------------------------------------------------------------

// Apparence d'un élément « À traiter » selon sa gravité.
const SEVERITY_STYLES = {
  alert: { border: "border-l-red-500", icon: "bg-red-50 text-red-600", label: "Urgent", badge: "danger" },
  warn: { border: "border-l-amber-400", icon: "bg-amber-50 text-amber-600", label: "À faire", badge: "warning" },
  info: { border: "border-l-gray-300", icon: "bg-gray-100 text-gray-500", label: "Info", badge: "default" },
};

// Icône d'un élément « À traiter » selon son type.
const TODO_ICONS = {
  intake: Pill,
  vaccine: Syringe,
  relay: HandHeart,
  attendance: CalendarCheck,
  fiche: ClipboardPen,
  delivery: Package,
  invitation: Mail,
};

// Icône d'une ligne d'activité selon sa nature.
const ACTIVITY_ICONS = {
  document: { icon: FileText, color: "bg-violet-50 text-violet-600" },
  intake: { icon: Pill, color: "bg-emerald-50 text-emerald-600" },
  appointment: { icon: Calendar, color: "bg-blue-50 text-blue-600" },
  relay: { icon: HandHeart, color: "bg-amber-50 text-amber-600" },
};

// Libellés des voyants d'état d'un membre.
const LIGHT_STYLES = {
  green: { dot: "bg-emerald-500", text: "text-emerald-700", box: "bg-emerald-50" },
  orange: { dot: "bg-amber-500", text: "text-amber-700", box: "bg-amber-50" },
  red: { dot: "bg-red-500", text: "text-red-700", box: "bg-red-50" },
};

const capitalize = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const toDate = (d) => (typeof d === "string" ? parseISO(d) : d);
const dayKey = (d) => format(toDate(d), "yyyy-MM-dd");
const timeOf = (d) => format(toDate(d), "HH:mm");
const pctText = (pct) => (pct == null ? "—" : `${Math.round(pct)} %`);

// Nom de famille affiché sans double préfixe « Famille Famille ».
function familyDisplayName(name) {
  if (!name) return "";
  return /^\s*famille(\s|$)/i.test(name) ? name.replace(/^\s*famille\s*/i, "") : name;
}

// Pastille d'initiales (tolère un membre inconnu ou incomplet).
function Avatar({ member, size = "md" }) {
  const sizeClass = { sm: "w-7 h-7 text-[11px]", md: "w-10 h-10 text-sm", lg: "w-12 h-12 text-base" }[size];
  const initials = member
    ? `${member.firstName?.[0] ?? ""}${member.lastName?.[0] ?? ""}`.toUpperCase() || "?"
    : "?";
  return (
    <div
      className={cn(sizeClass, "rounded-full flex items-center justify-center font-bold text-white flex-shrink-0 shadow-sm")}
      style={{ backgroundColor: member?.avatarColor ?? "#94A3B8" }}
    >
      {initials}
    </div>
  );
}

// En-tête commun des blocs.
function SectionTitle({ icon: Icon, iconClass, children, right }) {
  return (
    <div className="flex items-center justify-between gap-3 mb-4">
      <h3 className="font-bold text-gray-800 flex items-center gap-2 text-base">
        <Icon size={18} className={iconClass} />
        {children}
      </h3>
      {right}
    </div>
  );
}

// Squelette de chargement.
function Skeleton() {
  const bar = "bg-gray-200/80 rounded-lg animate-pulse";
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <div className={cn(bar, "h-8 w-56")} />
        <div className={cn(bar, "h-4 w-96 max-w-full")} />
      </div>
      <div className="bg-white rounded-2xl border border-gray-100 p-6 space-y-3">
        <div className={cn(bar, "h-5 w-40")} />
        {[0, 1, 2].map((i) => (
          <div key={i} className={cn(bar, "h-16 w-full")} />
        ))}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className={cn(bar, "h-64")} />
        <div className={cn(bar, "h-64")} />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
        {[0, 1, 2].map((i) => (
          <div key={i} className={cn(bar, "h-48")} />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bloc 1 — « À traiter »
// ---------------------------------------------------------------------------
function TodoActions({ item, busy, onIntake, onBooster, onAttendance }) {
  const action = item.action;
  const small =
    "inline-flex items-center gap-1 text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap";
  const primary = cn(small, "bg-emerald-600 text-white hover:bg-emerald-700");
  const secondary = cn(small, "bg-white text-red-600 border border-red-200 hover:bg-red-50");
  const neutral = cn(small, "bg-teal-600 text-white hover:bg-teal-700");
  const linkClass = cn(small, "text-teal-700 bg-teal-50 hover:bg-teal-100");

  if (!action) {
    return item.link ? (
      <Link to={item.link} className={linkClass}>
        Voir <ChevronRight size={12} />
      </Link>
    ) : null;
  }

  switch (action.kind) {
    case "intake":
      return (
        <div className="flex items-center gap-1.5">
          <button type="button" disabled={busy} onClick={() => onIntake(action.id, "taken")} className={primary}>
            Pris
          </button>
          <button type="button" disabled={busy} onClick={() => onIntake(action.id, "not_taken")} className={secondary}>
            Pas pris
          </button>
        </div>
      );
    case "booster":
      return (
        <button type="button" disabled={busy} onClick={() => onBooster(action.id)} className={neutral}>
          <Syringe size={12} /> Rappel effectué
        </button>
      );
    case "attendance":
      return (
        <div className="flex items-center gap-1.5 flex-wrap">
          <button type="button" disabled={busy} onClick={() => onAttendance(action.id, "attended")} className={primary}>
            S&apos;y est rendu
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onAttendance(action.id, "missed")}
            className={cn(small, "bg-white text-gray-700 border border-gray-200 hover:bg-gray-50")}
          >
            N&apos;y est pas allé
          </button>
        </div>
      );
    case "village":
      return (
        <Link to="/village" className={neutral}>
          <HandHeart size={12} /> Ouvrir le Village
        </Link>
      );
    case "edit":
      return (
        <Link to={item.link || "/fiches"} className={neutral}>
          <ClipboardPen size={12} /> Compléter
        </Link>
      );
    default:
      return item.link ? (
        <Link to={item.link} className={linkClass}>
          Voir <ChevronRight size={12} />
        </Link>
      ) : null;
  }
}

function TodoBlock({ todo, memberById, busyKey, handlers }) {
  if (todo.length === 0) {
    return (
      <div className="bg-emerald-50 border border-emerald-200 rounded-2xl p-5 flex items-center gap-3">
        <CheckCircle2 size={28} className="text-emerald-600 flex-shrink-0" />
        <div>
          <p className="font-bold text-emerald-800">Rien à traiter : tout est à jour dans la famille ✓</p>
          <p className="text-sm text-emerald-700/80">Aucune prise, aucun rappel ni aucune réponse en attente.</p>
        </div>
      </div>
    );
  }

  const alerts = todo.filter((t) => t.severity === "alert").length;

  return (
    <div className={cn("bg-white rounded-2xl shadow-sm border p-5 sm:p-6", alerts ? "border-red-200" : "border-amber-200")}>
      <SectionTitle
        icon={BellRing}
        iconClass={alerts ? "text-red-600" : "text-amber-600"}
        right={
          alerts > 0 && (
            <Badge variant="danger" className="px-2 py-0.5">
              {alerts} urgent{alerts > 1 ? "s" : ""}
            </Badge>
          )
        }
      >
        À traiter ({todo.length})
      </SectionTitle>
      <div className="space-y-2">
        {todo.map((item, i) => {
          const sev = SEVERITY_STYLES[item.severity] ?? SEVERITY_STYLES.info;
          const Icon = TODO_ICONS[item.type] ?? (item.severity === "alert" ? AlertTriangle : Info);
          const member = item.memberId != null ? memberById(item.memberId) : null;
          const key = `${item.type}-${item.action?.id ?? i}`;
          return (
            <div
              key={key}
              className={cn(
                "flex flex-col sm:flex-row sm:items-center gap-3 p-3 rounded-xl border border-gray-100 border-l-4 bg-white hover:bg-gray-50/60 transition-colors",
                sev.border
              )}
            >
              <div className="flex items-center gap-3 min-w-0 flex-1">
                <div className={cn("w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0", sev.icon)}>
                  <Icon size={18} />
                </div>
                {member && <Avatar member={member} size="sm" />}
                <div className="min-w-0">
                  <p className="font-semibold text-gray-800 text-sm">
                    {item.title}
                  </p>
                  {item.detail && <p className="text-xs text-gray-500">{item.detail}</p>}
                </div>
              </div>
              <div className="flex-shrink-0 sm:ml-auto pl-[52px] sm:pl-0">
                <TodoActions item={item} busy={busyKey === key} {...handlers(key)} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bloc 2 — Agenda : aujourd'hui et les 7 prochains jours
// ---------------------------------------------------------------------------
function AgendaBlock({ agenda, today }) {
  const todayDate = parseISO(today);
  const days = (() => {
    const byDay = new Map();
    for (let i = 0; i <= 7; i++) byDay.set(format(addDays(todayDate, i), "yyyy-MM-dd"), []);
    for (const a of agenda.appointments ?? []) {
      const k = dayKey(a.appointmentDate);
      if (!byDay.has(k)) byDay.set(k, []);
      byDay.get(k).push(a);
    }
    return [...byDay.entries()]
      .map(([k, appts]) => ({ key: k, appts: appts.sort((x, y) => (x.appointmentDate < y.appointmentDate ? -1 : 1)) }))
      .filter((d) => d.key === today || d.appts.length > 0)
      .sort((a, b) => (a.key < b.key ? -1 : 1));
  })();

  const dayLabel = (k) => {
    if (k === today) return "Aujourd'hui";
    if (k === format(addDays(todayDate, 1), "yyyy-MM-dd")) return "Demain";
    return capitalize(format(parseISO(k), "EEEE d MMMM", { locale: fr }));
  };

  const intakesToday = [...(agenda.intakesToday ?? [])].sort((a, b) => (a.scheduledAt < b.scheduledAt ? -1 : 1));
  const vaccinesSoon = agenda.vaccinesSoon ?? [];

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5 sm:p-6">
      <SectionTitle
        icon={Calendar}
        iconClass="text-blue-600"
        right={
          <Link to="/rendez-vous" className="text-xs text-teal-600 hover:underline font-medium">
            Tous les rendez-vous
          </Link>
        }
      >
        Aujourd&apos;hui et les 7 prochains jours
      </SectionTitle>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <div className="space-y-5 lg:col-span-2">
        {days.map((d) => {
          const isTodayKey = d.key === today;
          const empty = d.appts.length === 0 && (!isTodayKey || intakesToday.length === 0);
          return (
            <div key={d.key}>
              <p
                className={cn(
                  "text-xs font-bold uppercase tracking-wide mb-2",
                  isTodayKey ? "text-teal-700" : "text-gray-500"
                )}
              >
                {dayLabel(d.key)}
              </p>
              <div className="space-y-2">
                {d.appts.map((a) => (
                  <div key={`a-${a.id}`} className="flex gap-3 p-3 rounded-xl border border-gray-100">
                    <div className="w-12 flex-shrink-0 text-center">
                      <p className="text-sm font-bold text-blue-700">{timeOf(a.appointmentDate)}</p>
                      <Stethoscope size={14} className="text-blue-400 mx-auto mt-1" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold text-gray-800 text-sm">
                        {a.memberName} · {a.title}
                      </p>
                      <div className="flex items-center gap-3 flex-wrap mt-0.5">
                        {a.doctorName && <span className="text-xs text-gray-500">{a.doctorName}</span>}
                        {a.location && (
                          <span className="text-xs text-gray-400 flex items-center gap-1">
                            <MapPin size={11} /> {a.location}
                          </span>
                        )}
                        {a.status === "cancelled" && <Badge variant="danger" className="px-2 py-0.5">Annulé</Badge>}
                        {a.status === "pending" && <Badge variant="warning" className="px-2 py-0.5">À confirmer</Badge>}
                      </div>
                    </div>
                  </div>
                ))}

                {isTodayKey && intakesToday.length > 0 && (
                  <div className="rounded-xl bg-violet-50/50 border border-violet-100 p-3">
                    <p className="text-xs font-semibold text-violet-700 flex items-center gap-1.5 mb-2">
                      <Pill size={13} /> Prises de médicaments du jour
                    </p>
                    <ul className="space-y-1.5">
                      {intakesToday.map((it) => (
                        <li key={`i-${it.id}`} className="flex items-center justify-between gap-2 text-sm">
                          <span className="min-w-0 text-gray-700">
                            <span className="font-semibold text-gray-800">{timeOf(it.scheduledAt)}</span> · {it.memberName}
                            <span className="text-gray-500"> — {it.medication}</span>
                          </span>
                          <IntakeChip status={it.status} />
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {empty && <p className="text-sm text-gray-400 italic">Rien de prévu.</p>}
              </div>
            </div>
          );
        })}
      </div>

      <div className="pt-5 border-t border-gray-100 lg:pt-0 lg:border-t-0 lg:pl-6 lg:border-l">
        <p className="text-sm font-bold text-gray-700 flex items-center gap-2 mb-2">
          <Syringe size={15} className="text-amber-600" /> Rappels de vaccin à venir (30 jours)
        </p>
        {vaccinesSoon.length === 0 ? (
          <p className="text-sm text-gray-400 italic">Aucun rappel prévu dans les 30 prochains jours.</p>
        ) : (
          <ul className="space-y-1.5">
            {vaccinesSoon.map((v) => (
              <li key={`v-${v.id}`} className="flex items-center justify-between gap-2 text-sm">
                <span className="text-gray-700 min-w-0">
                  <span className="font-semibold text-gray-800">{v.memberName}</span> · {v.vaccineName}
                </span>
                <span className="text-xs text-gray-500 flex-shrink-0">{formatDate(v.nextDoseDate)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      </div>
    </div>
  );
}

// Pastille d'état d'une prise dans l'agenda.
function IntakeChip({ status }) {
  if (status === "taken")
    return <Badge variant="success" className="px-2 py-0.5 flex-shrink-0">fait ✓</Badge>;
  if (status === "not_taken")
    return <Badge variant="danger" className="px-2 py-0.5 flex-shrink-0">pas pris ✗</Badge>;
  if (status === "pending")
    return <Badge variant="warning" className="px-2 py-0.5 flex-shrink-0">en attente</Badge>;
  if (status === "missed")
    return <Badge variant="default" className="px-2 py-0.5 flex-shrink-0">sans réponse</Badge>;
  return <IntakeStatusBadge status={status} className="flex-shrink-0" />;
}

// ---------------------------------------------------------------------------
// Bloc 3 — Les membres
// ---------------------------------------------------------------------------
function MemberCard({ member, label, onOpen }) {
  const fullName = `${member.firstName} ${member.lastName}`;
  const header = (
    <div className="flex items-start gap-3">
      <Avatar member={member} size="lg" />
      <div className="min-w-0 flex-1">
        <p className="font-bold text-gray-800 truncate">{fullName}</p>
        <div className="flex items-center gap-1.5 flex-wrap mt-1">
          <Badge variant={label === "Vous" ? "success" : "info"} className="px-2 py-0.5">
            {label}
          </Badge>
          {member.age != null && <span className="text-xs text-gray-500">{member.age} ans</span>}
          {member.account?.role === "parent" && (
            <Badge variant="default" className="px-2 py-0.5">
              {member.account.isPrimaryAdmin ? "Administrateur" : "Co-administrateur"}
            </Badge>
          )}
        </div>
      </div>
    </div>
  );

  // Dossier médical de l'autre parent : identité seulement (confidentialité).
  if (member.private) {
    return (
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
        {header}
        <div className="mt-4 flex items-center gap-2 text-sm text-gray-500 bg-gray-50 rounded-xl px-3 py-2.5">
          <Lock size={15} className="text-gray-400" /> Dossier médical privé
        </div>
      </div>
    );
  }

  const light = LIGHT_STYLES[member.light];
  const treatments = member.treatments ?? [];
  const alerts = member.alerts ?? [];

  return (
    <button
      type="button"
      onClick={onOpen}
      className="text-left bg-white rounded-2xl border border-gray-100 shadow-sm p-5 hover:shadow-md hover:border-teal-200 transition-all group"
    >
      {header}

      {light && (
        <div className={cn("mt-4 rounded-xl px-3 py-2", light.box)}>
          <p className={cn("text-sm font-semibold flex items-center gap-2", light.text)}>
            <span className={cn("w-2.5 h-2.5 rounded-full flex-shrink-0", light.dot)} />
            {member.light === "green" ? "Tout est à jour" : member.light === "red" ? "Attention requise" : "À surveiller"}
          </p>
          {member.light !== "green" && alerts.length > 0 && (
            <ul className={cn("mt-1 ml-[18px] list-disc text-xs space-y-0.5", light.text)}>
              {alerts.map((a, i) => (
                <li key={i}>{a}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <dl className="mt-4 space-y-2.5 text-sm">
        <div className="flex gap-2">
          <dt className="flex-shrink-0 pt-0.5">
            <Calendar size={14} className="text-blue-500" />
          </dt>
          <dd className="min-w-0 text-gray-700">
            {member.nextAppointment ? (
              <>
                <span className="font-medium">{member.nextAppointment.title}</span>
                <span className="text-gray-500">
                  {" "}
                  · {format(toDate(member.nextAppointment.appointmentDate), "d MMM 'à' HH:mm", { locale: fr })}
                  {member.nextAppointment.location ? ` · ${member.nextAppointment.location}` : ""}
                </span>
              </>
            ) : (
              <span className="text-gray-400">Aucun rendez-vous prévu</span>
            )}
          </dd>
        </div>

        <div className="flex gap-2">
          <dt className="flex-shrink-0 pt-0.5">
            <Pill size={14} className="text-violet-500" />
          </dt>
          <dd className="min-w-0 text-gray-700">
            {treatments.length === 0 ? (
              <span className="text-gray-400">Aucun traitement en cours</span>
            ) : (
              <ul className="space-y-0.5">
                {treatments.map((t) => {
                  const pct = t.adherence?.pct;
                  return (
                    <li key={t.id}>
                      <span className="font-medium">{t.disease}</span>
                      <span
                        className={cn(
                          pct == null ? "text-gray-400" : pct >= 80 ? "text-emerald-700" : pct >= 50 ? "text-amber-700" : "text-red-600"
                        )}
                      >
                        {" "}
                        · {pct == null ? "pas encore de prises" : `${Math.round(pct)} % des prises`}
                      </span>
                      {t.medications?.length > 0 && (
                        <span className="block text-xs text-gray-400 truncate">{t.medications.join(", ")}</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </dd>
        </div>

        <div className="flex gap-2">
          <dt className="flex-shrink-0 pt-0.5">
            <Syringe size={14} className="text-amber-500" />
          </dt>
          <dd className="min-w-0 text-gray-700">
            {member.nextVaccine ? (
              <>
                <span className="font-medium">{member.nextVaccine.vaccineName}</span>
                {member.nextVaccine.boosterStatus === "en_retard" ? (
                  <span className="text-red-600 font-semibold">
                    {" "}
                    · en retard depuis le {formatDate(member.nextVaccine.nextDoseDate)}
                  </span>
                ) : (
                  <span className="text-gray-500"> · rappel le {formatDate(member.nextVaccine.nextDoseDate)}</span>
                )}
              </>
            ) : (
              <span className="text-gray-400">Aucun rappel de vaccin prévu</span>
            )}
          </dd>
        </div>
      </dl>

      <p className="mt-4 text-xs font-semibold text-teal-600 flex items-center gap-1 opacity-70 group-hover:opacity-100">
        Ouvrir la fiche <ChevronRight size={12} />
      </p>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Bloc 4 — Indicateurs sur 30 jours
// ---------------------------------------------------------------------------
function IndicatorTile({ icon: Icon, color, title, value, sub, extra, danger }) {
  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
      <div className={cn("w-10 h-10 rounded-xl flex items-center justify-center mb-3", color)}>
        <Icon size={18} />
      </div>
      <p className={cn("text-3xl font-bold", danger ? "text-red-600" : "text-gray-800")}>{value}</p>
      <p className="text-sm font-medium text-gray-600 mt-1">{title}</p>
      {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
      {extra && <p className="text-xs text-amber-700 mt-0.5">{extra}</p>}
    </div>
  );
}

function IndicatorsBlock({ indicators }) {
  const { intakes = {}, appointments = {}, vaccines = {}, relays = {} } = indicators ?? {};
  const noData = "Pas encore de données";
  return (
    <div>
      <SectionTitle icon={Activity} iconClass="text-teal-600">
        La famille sur 30 jours
      </SectionTitle>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <IndicatorTile
          icon={Pill}
          color="bg-violet-50 text-violet-600"
          title="Prises suivies"
          value={pctText(intakes.pct)}
          sub={intakes.pct == null ? noData : `${intakes.taken} sur ${intakes.total}`}
        />
        <IndicatorTile
          icon={CalendarCheck}
          color="bg-blue-50 text-blue-600"
          title="Rendez-vous honorés"
          value={pctText(appointments.pct)}
          sub={appointments.pct == null ? noData : `${appointments.attended} sur ${appointments.answered}`}
          extra={appointments.unanswered > 0 ? `${appointments.unanswered} sans réponse` : null}
        />
        <IndicatorTile
          icon={Syringe}
          color={vaccines.late > 0 ? "bg-red-50 text-red-600" : "bg-amber-50 text-amber-600"}
          title="Vaccins à jour"
          value={vaccines.total ? `${vaccines.upToDate} sur ${vaccines.total}` : "—"}
          sub={
            !vaccines.total
              ? noData
              : vaccines.late > 0
                ? `${vaccines.late} rappel${vaccines.late > 1 ? "s" : ""} en retard`
                : "Aucun rappel en retard"
          }
          danger={vaccines.late > 0}
        />
        <IndicatorTile
          icon={HandHeart}
          color="bg-amber-50 text-amber-600"
          title="Relais faits à temps"
          value={relays.total ? `${relays.onTime} sur ${relays.total}` : "—"}
          sub={relays.total ? (relays.pct != null ? `${Math.round(relays.pct)} %` : null) : noData}
        />
      </div>
      <p className="text-xs text-gray-400 mt-2">Ces indicateurs couvrent les dossiers auxquels vous avez accès.</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bloc 5 — Activité récente
// ---------------------------------------------------------------------------
function ActivityBlock({ activity, memberById }) {
  return (
    <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5 sm:p-6">
      <SectionTitle icon={Clock} iconClass="text-gray-500">
        Activité récente
      </SectionTitle>
      {activity.length === 0 ? (
        <p className="text-sm text-gray-400 italic">Aucune activité récente.</p>
      ) : (
        <ol className="relative border-l border-gray-100 ml-4 space-y-4">
          {activity.map((ev, i) => {
            const conf = ACTIVITY_ICONS[ev.kind] ?? { icon: Info, color: "bg-gray-100 text-gray-500" };
            const Icon = conf.icon;
            const member = ev.memberId != null ? memberById(ev.memberId) : null;
            return (
              <li key={`${ev.kind}-${ev.at}-${i}`} className="pl-6 relative">
                <span
                  className={cn(
                    "absolute -left-4 top-0 w-8 h-8 rounded-full flex items-center justify-center ring-4 ring-white",
                    conf.color
                  )}
                >
                  <Icon size={14} />
                </span>
                <p className="text-sm text-gray-800">{ev.text}</p>
                <p className="text-xs text-gray-400 mt-0.5">
                  {formatTimeAgo(ev.at)}
                  {member && !ev.text?.includes(member.firstName) ? ` · ${member.firstName}` : ""}
                  {ev.by ? ` · par ${ev.by}` : ""}
                </p>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
export default function ParentDashboard() {
  const { selectedFamily, myMember, members } = useFamily();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busyKey, setBusyKey] = useState(null);

  // `silent` : rechargement après une action, sans réafficher le squelette.
  const load = useCallback(
    async (silent = false) => {
      if (!selectedFamily) return;
      if (!silent) setLoading(true);
      try {
        const res = await fetch(`/api/dashboard/family?familyId=${selectedFamily.id}`);
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || "Impossible de charger le tableau de bord");
        }
        setData(await res.json());
        setError(null);
      } catch (e) {
        if (!silent) setError(e.message || "Impossible de charger le tableau de bord");
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [selectedFamily]
  );

  useEffect(() => {
    load();
  }, [load]);

  // Rechargement quand une action est faite ailleurs (cloche, autre page…).
  useEffect(() => {
    const onRefresh = () => load(true);
    window.addEventListener(NOTIFICATIONS_REFRESH_EVENT, onRefresh);
    return () => window.removeEventListener(NOTIFICATIONS_REFRESH_EVENT, onRefresh);
  }, [load]);

  const dashMembers = data?.members ?? [];
  const memberById = useCallback(
    (id) => dashMembers.find((m) => String(m.id) === String(id)) ?? members.find((m) => String(m.id) === String(id)),
    [dashMembers, members]
  );

  // Exécute une action puis rafraîchit le tableau de bord et les notifications.
  const run = async (key, fn) => {
    if (busyKey) return;
    setBusyKey(key);
    try {
      const ok = await fn();
      if (ok) {
        notifyNotificationsChanged(); // déclenche aussi le rechargement de cette page
      }
    } finally {
      setBusyKey(null);
    }
  };

  const handlers = (key) => ({
    onIntake: (id, status) =>
      run(key, async () => {
        // respondIntake affiche déjà un toast en cas d'erreur et émet l'événement de rafraîchissement.
        const updated = await respondIntake(id, status);
        if (updated) toast.success(status === "taken" ? "Prise enregistrée" : "Prise non effectuée enregistrée");
        return false;
      }),
    onBooster: (id) => {
      if (!window.confirm("Enregistrer le rappel fait aujourd'hui ?")) return;
      run(key, async () => {
        try {
          const res = await fetch(`/api/vaccinations/${id}/booster-done`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
          });
          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            toast.error(err.error || "Impossible d'enregistrer le rappel");
            return false;
          }
          toast.success("Rappel enregistré");
          return true;
        } catch {
          toast.error("Impossible d'enregistrer le rappel");
          return false;
        }
      });
    },
    onAttendance: (id, attendance) =>
      run(key, async () => {
        try {
          const res = await fetch("/api/appointments/attendance", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id, attendance }),
          });
          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            toast.error(err.error || "Impossible d'enregistrer la présence");
            return false;
          }
          toast.success("Présence enregistrée");
          return true;
        } catch {
          toast.error("Impossible d'enregistrer la présence");
          return false;
        }
      }),
  });

  const firstName = myMember?.firstName || user?.name?.split(" ")[0] || "";
  const familyName = familyDisplayName(selectedFamily?.name);
  const longDate = format(data?.today ? parseISO(data.today) : new Date(), "EEEE d MMMM yyyy", { locale: fr });
  const counts = data?.counts;

  return (
    <AppShell>
      {loading && !data ? (
        <Skeleton />
      ) : error && !data ? (
        <div className="max-w-lg mx-auto mt-10 bg-white rounded-2xl border border-red-200 p-6 text-center">
          <AlertTriangle size={32} className="mx-auto text-red-500 mb-2" />
          <p className="font-semibold text-gray-800">Le tableau de bord n&apos;a pas pu être chargé.</p>
          <p className="text-sm text-gray-500 mt-1">{error}</p>
          <Button variant="outline" size="sm" className="mt-4" onClick={() => load()}>
            <RefreshCw size={14} /> Réessayer
          </Button>
        </div>
      ) : (
        <div className="space-y-6">
          {/* 0. En-tête */}
          <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
            <div>
              <h2 className="text-2xl font-bold text-gray-800">Bonjour {firstName}</h2>
              <p className="text-gray-600 mt-0.5">
                Voici ce qui se passe dans la famille {familyName} aujourd&apos;hui, {longDate}.
              </p>
              {counts && (
                <p className="text-xs text-gray-400 mt-1">
                  {counts.members} membre{counts.members > 1 ? "s" : ""} · {counts.accounts} compte
                  {counts.accounts > 1 ? "s" : ""}
                </p>
              )}
            </div>
            {/* Actions rapides, volontairement discrètes */}
            <div className="flex items-center gap-2 flex-wrap">
              <Link
                to="/membres"
                className="inline-flex items-center gap-1.5 text-xs font-semibold text-gray-600 bg-white border border-gray-200 hover:bg-gray-50 px-3 py-1.5 rounded-lg"
              >
                <UserPlus size={14} /> Ajouter un membre
              </Link>
              <Link
                to="/rendez-vous"
                className="inline-flex items-center gap-1.5 text-xs font-semibold text-gray-600 bg-white border border-gray-200 hover:bg-gray-50 px-3 py-1.5 rounded-lg"
              >
                <CalendarPlus size={14} /> Nouveau rendez-vous
              </Link>
            </div>
          </div>

          {/* Indicateurs de la famille en haut de page : l'état général d'un coup d'œil */}
          <IndicatorsBlock indicators={data.indicators} />

          {/* 1. À traiter */}
          <TodoBlock todo={data.todo ?? []} memberById={memberById} busyKey={busyKey} handlers={handlers} />

          {/* 2. Agenda */}
          <AgendaBlock agenda={data.agenda ?? {}} today={data.today ?? format(new Date(), "yyyy-MM-dd")} />

          {/* 3. Les membres */}
          <div>
            <SectionTitle
              icon={Users}
              iconClass="text-teal-600"
              right={
                <Link to="/membres" className="text-xs text-teal-600 hover:underline font-medium">
                  Gérer les membres
                </Link>
              }
            >
              Les membres
            </SectionTitle>
            {dashMembers.length === 0 ? (
              <p className="text-sm text-gray-400 italic">Aucun membre enregistré pour l&apos;instant.</p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
                {dashMembers.map((m) => (
                  <MemberCard
                    key={m.id}
                    member={m}
                    label={kinshipLabel(m, myMember, members.length ? members : dashMembers)}
                    onOpen={() => navigate(`/fiches?fiche=${m.id}`)}
                  />
                ))}
              </div>
            )}
          </div>


          {/* 5. Activité récente */}
          <ActivityBlock activity={data.activity ?? []} memberById={memberById} />
        </div>
      )}
    </AppShell>
  );
}
