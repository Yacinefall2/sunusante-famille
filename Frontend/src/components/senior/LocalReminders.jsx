import { useEffect, useRef } from "react";
import toast from "react-hot-toast";
import { useAuth } from "../../context/AuthContext";
import { useFamily } from "../../context/FamilyContext";
import { useOnline } from "../../lib/offline";
import { SW_PUSH_EVENT } from "../../lib/pwa";
import {
  LOCAL_ALERT_EVENT,
  intakeTag,
  markAlerted,
  notificationPermission,
  playAlertSound,
  showBrowserNotification,
  wasAlerted,
} from "../../lib/seniorAlerts";

// ── Rappels locaux (cahier des charges §10) ─────────────────────────────────
// Application OUVERTE et HORS LIGNE : les prises du jour déjà connues (données
// gardées sur l'appareil) déclenchent l'alerte à l'heure dite, sans le
// serveur. Mode senior : son, notification et grande alerte ; sinon une
// notification simple. Une prise déjà signalée (push reçu, alerte de la
// cloche) ne l'est pas une seconde fois (même « tag »).
// En ligne, rien à faire : le serveur envoie les rappels (cloche, push).

const CHECK_MS = 30 * 1000;
// Une prise est signalée jusqu'à 10 min après son heure (application ouverte
// un peu en retard, onglet en veille).
const WINDOW_MS = 10 * 60 * 1000;

const pad = (n) => String(n).padStart(2, "0");
const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

async function cachedJson(url) {
  try {
    // offlineSilent : lecture en arrière-plan, sans effet sur le bandeau
    // « Hors ligne » (lib/session.js)
    const res = await fetch(url, { offlineSilent: true });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// Prises prévues aujourd'hui sur les fiches dont la personne reçoit les
// rappels : la sienne, et celles qu'elle gère sans titulaire (enfant,
// proche sans compte) — comme le moteur de rappels du serveur.
async function todaysIntakes({ familyId, members }) {
  const targets = members.filter((m) => m.isMine || (m.access === "full" && !m.hasAccount));
  if (targets.length === 0) return [];
  const byId = new Map(targets.map((m) => [m.id, m]));
  // Données déjà consultées : par fiche (accueil senior, fiches) ou toute la
  // famille (page Traitements).
  let treatments = [];
  for (const m of targets) {
    const list = await cachedJson(`/api/treatments?memberId=${m.id}`);
    if (Array.isArray(list)) treatments.push(...list);
  }
  if (treatments.length === 0 && familyId) {
    const list = await cachedJson(`/api/treatments?familyId=${familyId}`);
    if (Array.isArray(list)) treatments = list.filter((t) => byId.has(t.memberId));
  }
  const now = new Date();
  const today = isoDay(now);
  const result = [];
  for (const t of treatments) {
    if (!t.isActive || (t.startDate && t.startDate > today) || (t.endDate && t.endDate < today)) continue;
    const member = byId.get(t.memberId);
    if (!member) continue;
    for (const med of t.medications ?? []) {
      for (const time of med.intakeTimes ?? []) {
        const [h, mi] = time.split(":").map(Number);
        const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, mi);
        result.push({ med, member, time, at, tag: intakeTag(med.id, at) });
      }
    }
  }
  return result;
}

export function LocalReminders() {
  const { seniorMode } = useAuth();
  const { selectedFamily, members } = useFamily();
  const online = useOnline();
  const ctx = useRef({});
  ctx.current = { familyId: selectedFamily?.id ?? null, members, seniorMode };

  // Push reçu pendant que l'application est ouverte : pas d'alerte locale
  // en double pour la même prise.
  useEffect(() => {
    const onPush = (e) => {
      if (e.detail?.tag) markAlerted(e.detail.tag);
    };
    window.addEventListener(SW_PUSH_EVENT, onPush);
    return () => window.removeEventListener(SW_PUSH_EVENT, onPush);
  }, []);

  useEffect(() => {
    if (online) return;
    let stopped = false;
    const check = async () => {
      const { familyId, members: list, seniorMode: senior } = ctx.current;
      const intakes = await todaysIntakes({ familyId, members: list });
      if (stopped) return;
      const now = Date.now();
      const due = intakes.filter((i) => now >= i.at.getTime() && now - i.at.getTime() <= WINDOW_MS && !wasAlerted(i.tag));
      if (due.length === 0) return;
      for (const i of due) {
        markAlerted(i.tag);
        const what = [i.med.name, i.med.dosage].filter(Boolean).join(" ");
        const mine = i.member.isMine;
        const title = mine && senior ? "C'est l'heure de votre médicament" : `C'est l'heure : ${what}`;
        const body = mine && senior ? what : `${i.member.firstName} ${i.member.lastName} — prise de ${i.time}`;
        showBrowserNotification({ tag: i.tag, title, body, url: "/dashboard" });
        if (senior) {
          window.dispatchEvent(new CustomEvent(LOCAL_ALERT_EVENT, { detail: { category: "medication_intake", title, body, tag: i.tag } }));
        } else if (notificationPermission() !== "granted") {
          toast(`${title} — ${body}`, { duration: 15000 });
        }
      }
      if (senior) playAlertSound();
    };
    check();
    const timer = setInterval(check, CHECK_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [online]);

  return null;
}
