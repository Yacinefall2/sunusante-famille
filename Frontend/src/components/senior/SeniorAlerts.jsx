import { useEffect, useRef, useState } from "react";
import { CalendarClock, Pill } from "lucide-react";
import { Modal } from "../ui/Modal";
import { useAuth } from "../../context/AuthContext";
import { useFamily } from "../../context/FamilyContext";
import { notifyNotificationsChanged } from "../notifications/intakes";
import { BigIntakeButtons } from "./BigIntakeButtons";
import { formatIsoDatesInText } from "../../lib/utils";
import {
  LOCAL_ALERT_EVENT,
  installAudioUnlockOnGesture,
  intakeTag,
  markAlerted,
  playAlertSound,
  sessionOpenedAt,
  shouldAlert,
  showBrowserNotification,
} from "../../lib/seniorAlerts";

// Intervalle d'interrogation des notifications en mode senior (la cloche,
// elle, interroge toutes les 60 s).
export const SENIOR_POLL_MS = 30000;

const medicationLabel = (n) => [n.medicationName, n.medicationDosage].filter(Boolean).join(" ");

// Texte de l'alerte : pour SA prise, « C'est l'heure de votre médicament :
// Amlodipine 5 mg » ; sinon (fiche d'un proche qu'il gère) le texte de la
// notification tel quel.
export function alertText(n, myMemberId) {
  if (n.category === "medication_intake" && n.memberId === myMemberId && n.medicationName) {
    return { title: "C'est l'heure de votre médicament", body: medicationLabel(n) };
  }
  return { title: formatIsoDatesInText(n.title), body: formatIsoDatesInText(n.body ?? "") };
}

// Alertes sonores du mode senior (UC-25) : monté une fois pour toute
// l'application connectée. Quand une NOUVELLE notification de prise de
// médicament ou de rendez-vous arrive, joue le signal sonore, affiche une
// notification du navigateur et une grande alerte à l'écran. Hors mode
// senior : ne fait rien (comportement habituel de la cloche).
export function SeniorAlerts() {
  const { seniorMode } = useAuth();
  const { myMember } = useFamily();
  const myMemberId = useRef(null);
  myMemberId.current = myMember?.id ?? null;
  const [queue, setQueue] = useState([]);

  useEffect(() => {
    installAudioUnlockOnGesture();
  }, []);

  useEffect(() => {
    if (!seniorMode) {
      setQueue([]);
      return;
    }
    const openedAt = sessionOpenedAt();
    let stopped = false;
    const check = async () => {
      try {
        const res = await fetch("/api/notifications");
        if (!res.ok || stopped) return;
        const data = await res.json();
        const fresh = (Array.isArray(data?.items) ? data.items : []).filter((n) => shouldAlert(n, openedAt)).reverse();
        if (stopped || fresh.length === 0) return;
        const tagOf = (n) => (n.medicationId && n.intakeScheduledAt ? intakeTag(n.medicationId, n.intakeScheduledAt) : undefined);
        fresh.forEach((n) => {
          markAlerted(n.id);
          if (tagOf(n)) markAlerted(tagOf(n));
        });
        setQueue((q) => [...q, ...fresh]);
        playAlertSound();
        fresh.forEach((n) => showBrowserNotification({ id: n.id, tag: tagOf(n), ...alertText(n, myMemberId.current) }));
        notifyNotificationsChanged(); // la cloche et l'accueil se mettent à jour
      } catch {
        // Silencieux : nouvel essai au prochain passage.
      }
    };
    check();
    const timer = setInterval(check, SENIOR_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [seniorMode]);

  // Rappels locaux (application ouverte HORS LIGNE, LocalReminders) : même
  // grande alerte, sans réponse possible tant que la connexion est absente.
  useEffect(() => {
    if (!seniorMode) return;
    const onLocal = (e) => setQueue((q) => [...q, { ...e.detail, local: true }]);
    window.addEventListener(LOCAL_ALERT_EVENT, onLocal);
    return () => window.removeEventListener(LOCAL_ALERT_EVENT, onLocal);
  }, [seniorMode]);

  const current = queue[0];
  if (!current) return null;
  const next = () => setQueue((q) => q.slice(1));

  const acknowledge = async () => {
    try {
      await fetch(`/api/notifications/${current.id}/read`, { method: "POST" });
    } catch {
      // la notification restera simplement non lue
    }
    notifyNotificationsChanged();
    next();
  };

  const isIntake = current.category === "medication_intake" && (current.intakeId || current.local);
  const { title, body } = current.local ? current : alertText(current, myMemberId.current);
  const Icon = isIntake ? Pill : CalendarClock;

  return (
    <Modal open onClose={next} title={isIntake ? "Rappel de médicament" : "Rappel de rendez-vous"} description={title} size="lg">
      <div className="space-y-6 text-center">
        <div
          className={`mx-auto w-20 h-20 rounded-3xl flex items-center justify-center ${
            isIntake ? "bg-violet-100 text-violet-700" : "bg-blue-100 text-blue-700"
          }`}
        >
          <Icon size={44} />
        </div>
        <div>
          <p className="text-2xl font-bold text-gray-900">{title}</p>
          {body && <p className={`mt-2 ${isIntake ? "text-3xl font-extrabold text-violet-800" : "text-xl text-gray-800"}`}>{body}</p>}
        </div>
        {current.local ? (
          <>
            <p className="text-lg text-gray-700">
              Pas de connexion : vous pourrez indiquer « Pris » ou « Pas pris » dès le retour du réseau.
            </p>
            <button
              type="button"
              onClick={next}
              className="w-full min-h-[3.5rem] rounded-2xl bg-teal-600 hover:bg-teal-700 text-white text-xl font-bold focus:outline-none focus-visible:ring-4 focus-visible:ring-teal-300"
            >
              J'ai compris
            </button>
          </>
        ) : isIntake ? (
          <>
            <BigIntakeButtons intakeId={current.intakeId} onDone={next} />
            <button type="button" onClick={next} className="text-base font-semibold text-gray-600 underline">
              Répondre plus tard
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={acknowledge}
            className="w-full min-h-[3.5rem] rounded-2xl bg-teal-600 hover:bg-teal-700 text-white text-xl font-bold focus:outline-none focus-visible:ring-4 focus-visible:ring-teal-300"
          >
            J'ai compris
          </button>
        )}
        {queue.length > 1 && <p className="text-sm text-gray-600">Encore {queue.length - 1} rappel(s) après celui-ci.</p>}
      </div>
    </Modal>
  );
}
