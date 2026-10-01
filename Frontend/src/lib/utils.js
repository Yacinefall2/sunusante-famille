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

export const APPOINTMENT_STATUSES = [
  { value: "upcoming", label: "À venir", color: "bg-blue-100 text-blue-700" },
  { value: "completed", label: "Terminé", color: "bg-green-100 text-green-700" },
  { value: "cancelled", label: "Annulé", color: "bg-red-100 text-red-700" },
];
