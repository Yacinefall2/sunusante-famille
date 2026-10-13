import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  AlertCircle,
  FileHeart,
  FileLock,
  Filter,
  History,
  Home,
  Loader2,
  Mail,
  ScrollText,
  ShieldAlert,
  Stethoscope,
  TreePine,
  UserCog,
  FileSignature,
  Lock,
  Download,
} from "lucide-react";
import { format, isToday, isYesterday, parseISO } from "date-fns";
import { fr } from "date-fns/locale";
import { AppShell } from "../components/layout/AppShell";
import { Button } from "../components/ui/Button";
import { useFamily } from "../context/FamilyContext";
import { cn } from "../lib/utils";

// Journal d'activité (UC-10, §10 « Traçabilité »). Les phrases et la
// visibilité sont calculées par le serveur (GET /api/activity) : un parent
// voit toute l'activité de la famille hors fiche de l'autre parent, les
// autres comptes seulement l'activité sur leur propre dossier. Lecture seule.

// Icône et couleur par catégorie (clés renvoyées par le serveur).
const CATEGORY_STYLE = {
  invitations: { icon: Mail, color: "bg-blue-50 text-blue-600" },
  espace: { icon: Home, color: "bg-teal-50 text-teal-600" },
  roles: { icon: UserCog, color: "bg-violet-50 text-violet-600" },
  fiches: { icon: FileHeart, color: "bg-emerald-50 text-emerald-600" },
  documents: { icon: FileLock, color: "bg-amber-50 text-amber-600" },
  partage: { icon: Stethoscope, color: "bg-sky-50 text-sky-600" },
  urgence: { icon: ShieldAlert, color: "bg-red-50 text-red-600" },
  village: { icon: TreePine, color: "bg-lime-50 text-lime-700" },
  consentement: { icon: FileSignature, color: "bg-indigo-50 text-indigo-600" },
  exports: { icon: Download, color: "bg-orange-50 text-orange-600" },
};
const DEFAULT_STYLE = { icon: History, color: "bg-gray-100 text-gray-500" };

const PAGE_SIZE = 50;

const toDate = (value) => (typeof value === "string" ? parseISO(value) : new Date(value));

// « Aujourd'hui », « Hier », « lundi 12 octobre 2026 »
function dayLabel(date) {
  if (isToday(date)) return "Aujourd'hui";
  if (isYesterday(date)) return "Hier";
  return format(date, "EEEE d MMMM yyyy", { locale: fr });
}

// Regroupe les entrées (déjà triées, plus récentes d'abord) par jour.
function groupByDay(entries) {
  const groups = [];
  for (const entry of entries) {
    const date = toDate(entry.occurredAt);
    const key = format(date, "yyyy-MM-dd");
    const last = groups[groups.length - 1];
    if (last?.key === key) last.entries.push(entry);
    else groups.push({ key, label: dayLabel(date), entries: [entry] });
  }
  return groups;
}

export default function JournalPage() {
  const { selectedFamily, isParent } = useFamily();
  const [searchParams, setSearchParams] = useSearchParams();
  const fiche = searchParams.get("fiche") ?? "";
  const [category, setCategory] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const [entries, setEntries] = useState([]);
  const [meta, setMeta] = useState({ scope: null, members: [], categories: {} });
  const [nextCursor, setNextCursor] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);

  const query = useMemo(() => {
    if (!selectedFamily) return null;
    const params = new URLSearchParams({ familyId: String(selectedFamily.id), limit: String(PAGE_SIZE) });
    if (fiche) params.set("memberId", fiche);
    if (category) params.set("category", category);
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    return params;
  }, [selectedFamily, fiche, category, from, to]);

  const fetchPage = useCallback(
    async (before) => {
      const params = new URLSearchParams(query);
      if (before) params.set("before", before);
      const res = await fetch(`/api/activity?${params}`);
      const data = await res.json().catch(() => null);
      if (!res.ok || !data) throw new Error(data?.error || "Impossible de charger le journal d'activité");
      return data;
    },
    [query]
  );

  useEffect(() => {
    if (!query) {
      setEntries([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchPage(null)
      .then((data) => {
        if (cancelled) return;
        setEntries(data.entries ?? []);
        setNextCursor(data.nextCursor ?? null);
        setMeta({ scope: data.scope, members: data.members ?? [], categories: data.categories ?? {} });
      })
      .catch((e) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [query, fetchPage]);

  const loadMore = async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const data = await fetchPage(nextCursor);
      setEntries((prev) => [...prev, ...(data.entries ?? [])]);
      setNextCursor(data.nextCursor ?? null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoadingMore(false);
    }
  };

  const setFiche = (value) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set("fiche", value);
    else next.delete("fiche");
    setSearchParams(next, { replace: true });
  };

  const familyScope = meta.scope ? meta.scope === "family" : isParent;
  const hasFilters = Boolean(fiche || category || from || to);
  const resetFilters = () => {
    setCategory("");
    setFrom("");
    setTo("");
    setFiche("");
  };
  const groups = useMemo(() => groupByDay(entries), [entries]);

  return (
    <AppShell>
      <div className="space-y-6 max-w-4xl">
        <div className="flex items-start gap-3 bg-teal-50 border border-teal-100 rounded-2xl p-4">
          <ScrollText size={22} className="text-teal-600 flex-shrink-0 mt-0.5" />
          <div className="text-sm text-teal-900">
            <p className="font-semibold">
              {familyScope ? "Toute l'activité de la famille (hors fiche de l'autre parent)" : "Activité sur votre dossier"}
            </p>
            <p className="text-teal-800/80 mt-0.5">
              Invitations, rôles, partages, fiche d&apos;urgence, Village… Qui a fait quoi, et quand. Aucune donnée
              médicale n&apos;y figure.
            </p>
          </div>
        </div>

        {/* Filtres */}
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-4">
          <div className="flex items-center gap-2 mb-3 text-sm font-semibold text-gray-700">
            <Filter size={16} className="text-gray-400" />
            Filtrer
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {familyScope && (
              <label className="block text-xs font-medium text-gray-500">
                Fiche
                <select
                  value={fiche}
                  onChange={(e) => setFiche(e.target.value)}
                  className="mt-1 w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-teal-500"
                >
                  <option value="">Toutes les fiches</option>
                  {meta.members.map((m) => (
                    <option key={m.id} value={String(m.id)}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="block text-xs font-medium text-gray-500">
              Catégorie
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="mt-1 w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-teal-500"
              >
                <option value="">Toutes les catégories</option>
                {Object.entries(meta.categories).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-xs font-medium text-gray-500">
              Du
              <input
                type="date"
                value={from}
                max={to || undefined}
                onChange={(e) => setFrom(e.target.value)}
                className="mt-1 w-full rounded-xl border border-gray-200 px-3 py-2 text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-teal-500"
              />
            </label>
            <label className="block text-xs font-medium text-gray-500">
              Au
              <input
                type="date"
                value={to}
                min={from || undefined}
                onChange={(e) => setTo(e.target.value)}
                className="mt-1 w-full rounded-xl border border-gray-200 px-3 py-2 text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-teal-500"
              />
            </label>
          </div>
          {hasFilters && (
            <button type="button" onClick={resetFilters} className="mt-3 text-sm font-semibold text-teal-600 hover:underline">
              Effacer les filtres
            </button>
          )}
        </div>

        {loading ? (
          <div className="flex justify-center py-16">
            <Loader2 className="animate-spin text-teal-600" size={36} />
          </div>
        ) : error && entries.length === 0 ? (
          <div className="flex items-start gap-3 bg-red-50 border border-red-100 rounded-2xl p-4 text-sm text-red-800">
            <AlertCircle size={20} className="flex-shrink-0 mt-0.5" />
            <p>{error}</p>
          </div>
        ) : entries.length === 0 ? (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-10 text-center">
            <div className="w-14 h-14 rounded-2xl bg-teal-50 flex items-center justify-center mx-auto mb-4">
              <History size={28} className="text-teal-600" />
            </div>
            <h3 className="font-bold text-gray-800 mb-2">{hasFilters ? "Aucune activité pour ces filtres" : "Aucune activité pour l'instant"}</h3>
            <p className="text-sm text-gray-500 max-w-md mx-auto">
              {hasFilters
                ? "Élargissez la période ou choisissez une autre catégorie."
                : familyScope
                  ? "Les invitations, les rôles attribués, les partages avec un médecin et les autres actions sur l'espace familial apparaîtront ici."
                  : "Les rôles attribués sur votre dossier, les partages avec un médecin et les consultations de votre fiche d'urgence apparaîtront ici."}
            </p>
          </div>
        ) : (
          <div className="space-y-6">
            {groups.map((group) => (
              <section key={group.key}>
                <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2 first-letter:uppercase">{group.label}</h2>
                <ol className="bg-white rounded-2xl shadow-sm border border-gray-100 divide-y divide-gray-50">
                  {group.entries.map((entry) => {
                    const style = CATEGORY_STYLE[entry.category] ?? DEFAULT_STYLE;
                    const Icon = style.icon;
                    return (
                      <li key={entry.id} className="flex items-start gap-3 px-4 py-3">
                        <div className={cn("w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0", style.color)}>
                          <Icon size={18} />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm text-gray-800 break-words">{entry.text}</p>
                          <p className="text-xs text-gray-400 mt-0.5">
                            {format(toDate(entry.occurredAt), "HH:mm")}
                            {meta.categories[entry.category] ? ` · ${meta.categories[entry.category]}` : ""}
                          </p>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              </section>
            ))}

            {error && (
              <p className="text-sm text-red-700 flex items-center gap-2">
                <AlertCircle size={16} /> {error}
              </p>
            )}
            {nextCursor && (
              <div className="flex justify-center">
                <Button variant="outline" onClick={loadMore} loading={loadingMore}>
                  Charger plus
                </Button>
              </div>
            )}
          </div>
        )}

        <p className="flex items-start gap-2 text-xs text-gray-500 border-t border-gray-100 pt-4">
          <Lock size={14} className="flex-shrink-0 mt-0.5" />
          Le journal est conservé tant que l&apos;espace familial existe. Ses entrées ne peuvent être ni modifiées ni
          supprimées.
        </p>
      </div>
    </AppShell>
  );
}
