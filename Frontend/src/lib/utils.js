import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import { format, formatDistanceToNow, isAfter, parseISO } from "date-fns";
import { fr } from "date-fns/locale";

export function cn(...inputs) {
  return twMerge(clsx(inputs));
}

export function formatDate(date) {
  if (!date) return "—";
  const d = typeof date === "string" ? parseISO(date) : date;
  return format(d, "dd/MM/yyyy", { locale: fr });
}

export function formatDateTime(date) {
  if (!date) return "—";
  const d = typeof date === "string" ? parseISO(date) : date;
  return format(d, "dd/MM/yyyy à HH:mm", { locale: fr });
}

export function formatRelative(date) {
  if (!date) return "—";
  const d = typeof date === "string" ? parseISO(date) : date;
  return formatDistanceToNow(d, { addSuffix: true, locale: fr });
}

export function isFuture(date) {
  if (!date) return false;
  const d = typeof date === "string" ? parseISO(date) : date;
  return isAfter(d, new Date());
}

export function calculateAge(dob) {
  if (!dob) return null;
  const birth = parseISO(dob);
  const now = new Date();
  let age = now.getFullYear() - birth.getFullYear();
  const m = now.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < birth.getDate())) age--;
  return age;
}

export const AVATAR_COLORS = [
  "#3B82F6", // blue
  "#10B981", // emerald
  "#F59E0B", // amber
  "#EF4444", // red
  "#8B5CF6", // violet
  "#EC4899", // pink
  "#06B6D4", // cyan
  "#84CC16", // lime
];

export const BLOOD_TYPES = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"];

export const DOCUMENT_TYPES = [
  { value: "ordonnance", label: "Ordonnance" },
  { value: "resultat", label: "Résultat d'analyse" },
  { value: "radio", label: "Radiologie / Imagerie" },
  { value: "compte-rendu", label: "Compte-rendu médical" },
  { value: "autre", label: "Autre" },
];

// Statut de la prise de rendez-vous. La présence effective au rendez-vous
// est suivie séparément (champ "attendance").
export const APPOINTMENT_STATUSES = [
  { value: "pending", label: "En attente", color: "bg-amber-100 text-amber-700", variant: "warning" },
  { value: "confirmed", label: "Confirmé", color: "bg-blue-100 text-blue-700", variant: "info" },
  { value: "cancelled", label: "Annulé", color: "bg-red-100 text-red-700", variant: "danger" },
];

export function getAppointmentStatus(status) {
  return APPOINTMENT_STATUSES.find((s) => s.value === status) ?? null;
}

// Présence au rendez-vous (renseignable une fois la date passée).
export const APPOINTMENT_ATTENDANCES = [
  { value: "attended", label: "S'y est rendu", color: "bg-emerald-100 text-emerald-700", variant: "success" },
  { value: "missed", label: "N'y est pas allé", color: "bg-gray-200 text-gray-700", variant: "default" },
];

export function getAttendance(attendance) {
  return APPOINTMENT_ATTENDANCES.find((a) => a.value === attendance) ?? null;
}

export function attendanceLabel(attendance) {
  return getAttendance(attendance)?.label ?? "";
}
