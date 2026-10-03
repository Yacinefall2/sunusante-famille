import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  CalendarClock,
  Check,
  CheckCircle,
  ChevronDown,
  ChevronUp,
  Clock,
  History,
  Info,
  Loader2,
  MapPin,
  Phone,
  PhoneOff,
  Stethoscope,
  TreePine,
  UserRound,
  X,
} from "lucide-react";
import { format, parseISO } from "date-fns";
import { fr } from "date-fns/locale";
import toast from "react-hot-toast";
import { AppShell } from "../components/layout/AppShell";
import { MemberAvatar } from "../components/members/MemberAvatar";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { notifyNotificationsChanged } from "../components/notifications/intakes";
import { useFamily } from "../context/FamilyContext";
import { cn, formatDateTime, getAttendance } from "../lib/utils";
import { ficheRoleShortLabel } from "../lib/roles";

// Libellés des événements de l'historique des relais.
const EVENT_LABELS = {
  to_relay: "À relayer envoyé",
  follow_up: "Relance",
  escalated: "Escaladé aux relais",
  notified: "Prévenu",
  unreachable: "Pas joignable",
  attended: "S'y est rendu",
  missed: "N'y est pas allé",
};

const EVENT_COLORS = {
  to_relay: "bg-amber-400",
  follow_up: "bg-amber-500",
  escalated: "bg-orange-500",
  notified: "bg-emerald-500",
  unreachable: "bg-red-500",
  attended: "bg-emerald-600",
  missed: "bg-gray-400",
};

function toDate(value) {
  if (!value) return null;
  const d = typeof value === "string" ? parseISO(value) : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

// "mardi 7 octobre 2026"
function formatLongDate(value) {
  const d = toDate(value);
  return d ? format(d, "EEEE d MMMM yyyy", { locale: fr }) : "—";
}

// "14 h 30"
function formatHour(value) {
  const d = toDate(value);
  return d ? format(d, "HH 'h' mm", { locale: fr }) : "—";
}

// "14:30"
function formatHHMM(value) {
  const d = toDate(value);
  return d ? format(d, "HH:mm") : "";
}

function isPast(value) {
  const d = toDate(value);
  return !!d && d.getTime() <= Date.now();
}

// Libellé d'un événement de l'historique, avec la personne concernée.
function eventText(ev) {
  if (ev.type === "notified") return ev.userName ? `Prévenu par ${ev.userName}` : "Prévenu";
  if (ev.type === "unreachable") return ev.userName ? `Pas joignable (${ev.userName})` : "Pas joignable";
  const label = EVENT_LABELS[ev.type] ?? ev.type;
  return ev.userName ? `${label} · ${ev.userName}` : label;
}

export default function VillagePage() {
  const { selectedFamily, reloadMembers } = useFamily();
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  // Action en cours : "<taskId>:<action>" ou "attendance:<appointmentId>"
  const [busy, setBusy] = useState(null);

  const load = useCallback(async () => {
    if (!selectedFamily) {
      setEntries([]);
      setLoading(false);
      return;
    }
    try {
      const res = await fetch(`/api/village?familyId=${selectedFamily.id}`);
      const data = res.ok ? await res.json() : [];
      setEntries(Array.isArray(data) ? data : []);
    } catch {
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [selectedFamily]);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  // Après chaque action : données du village, fiches (badge « À relayer »)
  // et cloche des notifications.
  const refreshAll = useCallback(async () => {
    await Promise.all([load(), reloadMembers()]);
    notifyNotificationsChanged();
  }, [load, reloadMembers]);

  // Appel générique ; un 409 (déjà prévenu / rappel clos) affiche le message
  // du serveur puis recharge.
  const runAction = async (key, url, options, successMessage, fallbackError) => {
    setBusy(key);
    try {
      const res = await fetch(url, options);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || fallbackError);
        if (res.status === 409) await refreshAll();
        return;
      }
      toast.success(successMessage);
      await refreshAll();
    } catch {
      toast.error(fallbackError);
    } finally {
      setBusy(null);
    }
  };

  const markNotified = (task) =>
    runAction(
      `${task.id}:notified`,
      `/api/village/tasks/${task.id}/notified`,
      { method: "POST" },
      "Merci ! Le rappel est marqué « Prévenu ».",
      "Impossible d'enregistrer « Prévenu »"
    );

  const markUnreachable = (task) =>
    runAction(
      `${task.id}:unreachable`,
      `/api/village/tasks/${task.id}/unreachable`,
      { method: "POST" },
      "Le gestionnaire et l'administrateur familial ont été alertés",
      "Impossible d'enregistrer « Pas joignable »"
    );

  const setAttendance = (task, attendance) =>
    runAction(
      `attendance:${task.appointmentId}`,
      "/api/appointments/attendance",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: task.appointmentId, attendance }),
      },
      "Présence enregistrée",
      "Erreur lors de l'enregistrement de la présence"
    );

  return (
    <AppShell>
      <div className="space-y-6 max-w-4xl">
        <div className="flex items-start gap-3 bg-teal-50 border border-teal-100 rounded-2xl p-4">
          <TreePine size={22} className="text-teal-600 flex-shrink-0 mt-0.5" />
          <p className="text-sm text-teal-900">
            Vos proches sans smartphone : prévenez-les par téléphone avant chaque rendez-vous.
          </p>
        </div>

        {loading ? (
          <div className="flex justify-center py-16">
            <Loader2 className="animate-spin text-teal-600" size={36} />
          </div>
        ) : entries.length === 0 ? (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-10 text-center">
            <div className="w-14 h-14 rounded-2xl bg-teal-50 flex items-center justify-center mx-auto mb-4">
              <TreePine size={28} className="text-teal-600" />
            </div>
            <h3 className="font-bold text-gray-800 mb-2">Aucun proche à prévenir</h3>
            <p className="text-sm text-gray-500 max-w-md mx-auto">
              Un proche apparaît ici lorsque sa fiche a le statut « Non connecté » et que vous êtes son gestionnaire
              ou l&apos;un de ses relais.
            </p>
            <Link to="/membres" className="inline-block mt-4 text-sm font-semibold text-teal-600 hover:underline">
              Voir les membres
            </Link>
          </div>
        ) : (
          entries.map((entry) =>
            entry.role === "manager" ? (
              <ManagerCard
                key={entry.member.id}
                entry={entry}
                busy={busy}
                onNotified={markNotified}
                onAttendance={setAttendance}
              />
            ) : (
              <RelayCard key={entry.member.id} entry={entry} busy={busy} onNotified={markNotified} onUnreachable={markUnreachable} />
            )
          )
        )}
      </div>
    </AppShell>
  );
}

// ---------------------------------------------------------------------------
// Éléments communs

// `role` : rôle de l'utilisateur sur la fiche du proche ("gestionnaire" | "relais")
function CardHeader({ member, role, pending }) {
  return (
    <div className="flex items-center justify-between gap-3 flex-wrap">
      <MemberAvatar member={member} size="lg" showName />
      <div className="flex items-center gap-2">
        {pending && <Badge variant="warning">À relayer</Badge>}
        <Badge variant={role === "relais" ? "warning" : "info"}>{ficheRoleShortLabel(role)}</Badge>
      </div>
    </div>
  );
}

// Gros bouton « Prévenu » (vert plein).
function NotifiedButton({ task, busy, onNotified, className }) {
  return (
    <Button
      size="lg"
      onClick={() => onNotified(task)}
      loading={busy === `${task.id}:notified`}
      disabled={!!busy}
      className={cn("bg-emerald-600 hover:bg-emerald-700 focus:ring-emerald-500 text-lg py-4", className)}
    >
      {busy !== `${task.id}:notified` && <Check size={22} />}
      Prévenu
    </Button>
  );
}

function NotifiedLine({ task, short = false }) {
  return (
    <p className="text-sm font-semibold text-emerald-700 flex items-center gap-2">
      <CheckCircle size={16} className="flex-shrink-0" />
      {short
        ? `Déjà prévenu${task.notifiedByName ? ` par ${task.notifiedByName}` : ""}${
            task.notifiedAt ? ` à ${formatHHMM(task.notifiedAt)}` : ""
          }`
        : `Prévenu${task.notifiedByName ? ` par ${task.notifiedByName}` : ""}${
            task.notifiedAt ? ` le ${formatDateTime(task.notifiedAt)}` : ""
          }`}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Vue gestionnaire : accès complet à la fiche du proche.

function ManagerCard({ entry, busy, onNotified, onAttendance }) {
  const { member, tasks = [] } = entry;
  const [showHistory, setShowHistory] = useState(false);

  const toRelay = tasks
    .filter((t) => t.status === "to_relay")
    .sort((a, b) => (toDate(a.appointmentDate) ?? 0) - (toDate(b.appointmentDate) ?? 0));
  const next = toRelay[0] ?? null;
  const others = tasks.filter((t) => t.id !== next?.id);

  // Historique de tous les rappels, du plus récent au plus ancien.
  const events = tasks
    .flatMap((t) => (t.events ?? []).map((ev, i) => ({ ...ev, key: `${t.id}-${i}`, task: t })))
    .sort((a, b) => (toDate(b.createdAt) ?? 0) - (toDate(a.createdAt) ?? 0));

  return (
    <section className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 space-y-5">
      <CardHeader member={member} role="gestionnaire" pending={!!next} />

      {/* Bouton d'appel : élément le plus visible de la carte */}
      {member.phone ? (
        <a
          href={`tel:${member.phone.replace(/\s+/g, "")}`}
          className="flex items-center justify-center gap-3 w-full rounded-2xl bg-emerald-600 hover:bg-emerald-700 text-white text-xl font-bold py-5 shadow-md hover:shadow-lg transition-all focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2"
        >
          <Phone size={26} />
          Appeler {member.firstName}
          <span className="text-base font-medium opacity-80 hidden sm:inline">· {member.phone}</span>
        </a>
      ) : (
        <div className="flex items-center gap-3 rounded-2xl border-2 border-dashed border-gray-200 p-4 text-sm text-gray-600">
          <PhoneOff size={20} className="text-gray-400 flex-shrink-0" />
          <span>
            Aucun numéro :{" "}
            <Link to={`/fiches?fiche=${member.id}`} className="font-semibold text-teal-600 hover:underline">
              ajoutez-le sur sa fiche
            </Link>
          </span>
        </div>
      )}

      {/* Prochaine échéance */}
      {next ? (
        <div className="rounded-2xl border border-amber-200 bg-amber-50/60 p-5 space-y-4">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <h3 className="font-bold text-gray-800 flex items-center gap-2">
              <CalendarClock size={18} className="text-amber-600" /> Prochaine échéance
            </h3>
            <Badge variant="warning">À relayer</Badge>
          </div>
          <TaskDetails task={next} />
          {next.escalated && (
            <p className="text-sm text-orange-700 font-medium flex items-center gap-2">
              <Info size={15} className="flex-shrink-0" /> Les relais ont été sollicités.
            </p>
          )}
          {/* Deux actions seulement : l'appel (bouton ci-dessus) et « Prévenu » */}
          <NotifiedButton task={next} busy={busy} onNotified={onNotified} className="w-full sm:w-auto sm:px-10" />
        </div>
      ) : (
        <p className="text-sm text-gray-500 flex items-center gap-2">
          <CheckCircle size={16} className="text-emerald-500" /> Aucun rappel à relayer pour le moment.
        </p>
      )}

      {/* Autres rappels (à venir, prévenus, passés) */}
      {others.length > 0 && (
        <div className="space-y-3">
          <h4 className="text-xs font-bold text-gray-500 uppercase tracking-wide">Rendez-vous suivis</h4>
          {others.map((task) => (
            <ManagerTaskRow
              key={task.id}
              task={task}
              busy={busy}
              onNotified={onNotified}
              onAttendance={onAttendance}
            />
          ))}
        </div>
      )}

      {/* Historique des relais (repliable) */}
      <div className="border-t border-gray-100 pt-4">
        <button
          type="button"
          onClick={() => setShowHistory((v) => !v)}
          className="flex items-center gap-2 text-sm font-semibold text-gray-600 hover:text-teal-700"
          aria-expanded={showHistory}
        >
          <History size={16} />
          Historique des relais
          {showHistory ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </button>
        {showHistory &&
          (events.length === 0 ? (
            <p className="text-sm text-gray-400 italic mt-3">Aucun événement pour l&apos;instant.</p>
          ) : (
            <ol className="mt-4 space-y-3 border-l-2 border-gray-100 ml-2">
              {events.map((ev) => (
                <li key={ev.key} className="relative pl-5">
                  <span
                    className={cn(
                      "absolute -left-[7px] top-1.5 w-3 h-3 rounded-full ring-2 ring-white",
                      EVENT_COLORS[ev.type] ?? "bg-gray-300"
                    )}
                  />
                  <p className="text-sm font-medium text-gray-800">{eventText(ev)}</p>
                  <p className="text-xs text-gray-500">
                    {formatDateTime(ev.createdAt)}
                    {ev.task?.appointmentDate && (
                      <> · RDV du {formatDateTime(ev.task.appointmentDate)}</>
                    )}
                  </p>
                </li>
              ))}
            </ol>
          ))}
      </div>
    </section>
  );
}

// Détails complets d'un rendez-vous (gestionnaire uniquement).
function TaskDetails({ task }) {
  return (
    <div className="space-y-1.5">
      <p className="text-lg font-bold text-gray-800">
        <span className="capitalize">{formatLongDate(task.appointmentDate)}</span> à {formatHour(task.appointmentDate)}
      </p>
      {task.location && (
        <p className="text-sm text-gray-700 flex items-center gap-2">
          <MapPin size={15} className="text-gray-400 flex-shrink-0" /> {task.location}
        </p>
      )}
      {task.title && (
        <p className="text-sm text-gray-700 flex items-center gap-2">
          <Stethoscope size={15} className="text-gray-400 flex-shrink-0" /> {task.title}
        </p>
      )}
      {task.doctorName && (
        <p className="text-sm text-gray-700 flex items-center gap-2">
          <UserRound size={15} className="text-gray-400 flex-shrink-0" /> {task.doctorName}
        </p>
      )}
    </div>
  );
}

function ManagerTaskRow({ task, busy, onNotified, onAttendance }) {
  const past = isPast(task.appointmentDate);
  const cancelled = task.appointmentStatus === "cancelled";
  const attendance = getAttendance(task.attendance);
  const savingAttendance = busy === `attendance:${task.appointmentId}`;

  return (
    <div className="rounded-xl border border-gray-100 p-4 space-y-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <p className="font-semibold text-gray-800 text-sm flex items-center gap-2">
            <Clock size={14} className="text-gray-400" />
            {formatDateTime(task.appointmentDate)}
            {task.title && <span className="font-normal text-gray-500 truncate">· {task.title}</span>}
          </p>
          {task.location && (
            <p className="text-xs text-gray-500 flex items-center gap-1.5 mt-0.5">
              <MapPin size={12} /> {task.location}
            </p>
          )}
        </div>
        {task.status === "to_relay" && <Badge variant="warning">À relayer</Badge>}
        {task.status === "expired" && <Badge>Rappel expiré</Badge>}
        {cancelled && <Badge variant="danger">Annulé</Badge>}
      </div>

      {task.status === "notified" && <NotifiedLine task={task} />}

      {task.status === "to_relay" && !past && (
        <div className="flex flex-wrap gap-2">
          <NotifiedButton task={task} busy={busy} onNotified={onNotified} className="text-base py-2.5" />
          {task.escalated && (
            <span className="text-xs text-orange-700 self-center">Les relais ont été sollicités.</span>
          )}
        </div>
      )}

      {/* J+1 : présence au rendez-vous passé */}
      {past &&
        !cancelled &&
        (attendance ? (
          <Badge variant={attendance.variant}>{attendance.label}</Badge>
        ) : (
          <div className="space-y-2">
            <p className="text-sm text-gray-600">{`S'est-il rendu à ce rendez-vous ?`}</p>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                onClick={() => onAttendance(task, "attended")}
                disabled={!!busy}
                loading={savingAttendance}
                className="bg-emerald-600 hover:bg-emerald-700 focus:ring-emerald-500"
              >
                <Check size={15} /> S&apos;y est rendu
              </Button>
              <Button size="sm" variant="ghost" onClick={() => onAttendance(task, "missed")} disabled={!!busy} className="border border-gray-200">
                <X size={15} /> N&apos;y est pas allé
              </Button>
            </div>
          </div>
        ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Vue relais : seulement la date, l'heure et le lieu.

function RelayCard({ entry, busy, onNotified, onUnreachable }) {
  const { member, tasks = [] } = entry;
  const visible = tasks
    .filter((t) => t.status === "to_relay" || t.status === "notified")
    .sort((a, b) => (toDate(a.appointmentDate) ?? 0) - (toDate(b.appointmentDate) ?? 0));
  const pending = visible.some((t) => t.status === "to_relay");

  return (
    <section className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 space-y-5">
      <CardHeader member={member} role="relais" pending={pending} />

      <p className="text-sm text-gray-600 bg-gray-50 rounded-xl px-4 py-3 flex items-start gap-2">
        <Info size={16} className="text-teal-600 flex-shrink-0 mt-0.5" />
        Vous êtes relais : seuls la date, l&apos;heure et le lieu vous sont communiqués.
      </p>

      {visible.length === 0 ? (
        <p className="text-sm text-gray-500">Aucun rappel à relayer pour le moment.</p>
      ) : (
        visible.map((task) =>
          task.status === "to_relay" ? (
            <div key={task.id} className="rounded-2xl border border-amber-200 bg-amber-50/60 p-5 space-y-4">
              <div className="space-y-2">
                <p className="text-2xl font-bold text-gray-800">
                  <span className="capitalize">{formatLongDate(task.appointmentDate)}</span>
                </p>
                <p className="text-2xl font-bold text-gray-800 flex items-center gap-2">
                  <Clock size={22} className="text-amber-600" /> {formatHour(task.appointmentDate)}
                </p>
                {task.location && (
                  <p className="text-xl font-semibold text-gray-700 flex items-center gap-2">
                    <MapPin size={20} className="text-amber-600 flex-shrink-0" /> {task.location}
                  </p>
                )}
              </div>
              <div className="flex flex-col sm:flex-row gap-3">
                <NotifiedButton task={task} busy={busy} onNotified={onNotified} className="flex-1" />
                <Button
                  size="lg"
                  variant="ghost"
                  onClick={() => onUnreachable(task)}
                  loading={busy === `${task.id}:unreachable`}
                  disabled={!!busy}
                  className="flex-1 text-lg py-4 border-2 border-red-200 text-red-700 hover:bg-red-50"
                >
                  {busy !== `${task.id}:unreachable` && <PhoneOff size={20} />}
                  Pas joignable
                </Button>
              </div>
            </div>
          ) : (
            <div key={task.id} className="rounded-xl border border-gray-100 p-4 space-y-1">
              <p className="text-sm text-gray-700">
                <span className="capitalize">{formatLongDate(task.appointmentDate)}</span> à {formatHour(task.appointmentDate)}
                {task.location && <> · {task.location}</>}
              </p>
              <NotifiedLine task={task} short />
            </div>
          )
        )
      )}
    </section>
  );
}
