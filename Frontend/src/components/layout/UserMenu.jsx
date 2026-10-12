import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ChevronDown, UserCog, HeartPulse, ShieldPlus, BellRing, Users, Check, LogOut, Home, ScrollText, ZoomIn } from "lucide-react";
import toast from "react-hot-toast";
import { Switch } from "../ui/Switch";
import { cn } from "../../lib/utils";
import { useAuth } from "../../context/AuthContext";
import { useFamily } from "../../context/FamilyContext";
import { familyRoleLabel } from "../../lib/roles";

// Menu du compte connecté, ouvert en cliquant sur l'avatar de la barre du haut.
export function UserMenu() {
  const { user, logout, seniorMode, setSeniorMode } = useAuth();
  const [savingDisplay, setSavingDisplay] = useState(false);
  const { myRole, isPrimaryAdmin, isParent, myMember, families, selectedFamily, setSelectedFamily } = useFamily();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e) => ref.current && !ref.current.contains(e.target) && setOpen(false);
    const onKey = (e) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const initials = user?.name
    ? user.name
        .split(" ")
        .map((p) => p[0])
        .slice(0, 2)
        .join("")
        .toUpperCase()
    : "?";

  const close = () => setOpen(false);

  const handleLogout = async () => {
    close();
    try {
      await logout();
    } finally {
      navigate("/login");
    }
  };

  // Interrupteur rapide du mode senior (UC-25) — même réglage que « Mon compte ».
  const toggleSenior = async (on) => {
    setSavingDisplay(true);
    try {
      await setSeniorMode(on);
      toast.success(on ? "Mode senior activé : grands caractères et accueil simplifié" : "Mode senior désactivé");
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSavingDisplay(false);
    }
  };

  const switchFamily = (family) => {
    setSelectedFamily(family);
    close();
    navigate("/dashboard");
  };

  const items = [
    { to: "/compte", icon: UserCog, label: "Mon compte", hint: "Nom, adresse, mot de passe" },
    myMember && { to: `/fiches?fiche=${myMember.id}`, icon: HeartPulse, label: "Ma fiche médicale" },
    myMember && { to: `/partage?fiche=${myMember.id}`, icon: ShieldPlus, label: "Ma fiche d'urgence" },
    { to: "/notifications", icon: BellRing, label: "Notifications et préférences" },
    isParent && { to: "/famille", icon: Users, label: "Comptes & invitations" },
    // Journal d'activité : toute la famille pour un parent, son seul dossier sinon.
    isParent
      ? { to: "/journal", icon: ScrollText, label: "Journal d'activité" }
      : myMember && { to: `/journal?fiche=${myMember.id}`, icon: ScrollText, label: "Activité sur mon dossier" },
  ].filter(Boolean);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={`Menu du compte${user?.name ? ` — ${user.name}` : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-2 px-2 sm:px-3 py-1.5 rounded-xl hover:bg-gray-50 transition-colors"
      >
        <div
          className={cn(
            "bg-gradient-to-br from-teal-400 to-blue-500 rounded-full flex items-center justify-center text-white font-bold",
            seniorMode ? "w-12 h-12 text-lg" : "w-8 h-8 text-sm"
          )}
        >
          {initials}
        </div>
        <span className="text-sm font-medium text-gray-700 hidden sm:block">{user?.name}</span>
        <ChevronDown size={15} className={`text-gray-400 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 mt-2 w-72 bg-white rounded-2xl shadow-xl border border-gray-100 py-2 z-50"
        >
          <div className="px-4 pt-1 pb-3 border-b border-gray-100">
            <p className="text-sm font-bold text-gray-800 truncate">{user?.name}</p>
            <p className="text-xs text-gray-500 truncate">{user?.email}</p>
            {myRole && selectedFamily && (
              <p className="text-xs text-teal-700 mt-1 truncate">
                {familyRoleLabel(myRole, isPrimaryAdmin)} · {selectedFamily.name}
              </p>
            )}
          </div>

          <div className="py-1">
            {items.map(({ to, icon: Icon, label, hint }) => (
              <Link
                key={to}
                to={to}
                role="menuitem"
                onClick={close}
                className="flex items-center gap-3 px-4 py-2.5 text-sm text-gray-700 hover:bg-gray-50"
              >
                <Icon size={16} className="text-gray-400 flex-shrink-0" />
                <span className="min-w-0">
                  <span className="block">{label}</span>
                  {hint && <span className="block text-xs text-gray-400">{hint}</span>}
                </span>
              </Link>
            ))}
          </div>

          {/* Affichage : mode senior (grands caractères, accueil simplifié, alertes sonores) */}
          <div className="py-1 border-t border-gray-100">
            <div className="flex items-center gap-3 px-4 py-2.5">
              <ZoomIn size={16} className="text-gray-400 flex-shrink-0" />
              <span className="flex-1 min-w-0 text-sm text-gray-700">
                <span className="block">Mode senior</span>
                <span className="block text-xs text-gray-400">Grands caractères, alertes sonores</span>
              </span>
              <Switch checked={seniorMode} onChange={toggleSenior} disabled={savingDisplay} label="Mode senior" />
            </div>
          </div>

          {families.length > 1 && (
            <div className="py-1 border-t border-gray-100">
              <p className="px-4 pt-2 pb-1 text-xs font-semibold text-gray-400 uppercase tracking-wide">Changer de famille</p>
              {families.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  role="menuitem"
                  onClick={() => switchFamily(f)}
                  className="w-full flex items-center gap-3 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 text-left"
                >
                  <Home size={16} className="text-gray-400 flex-shrink-0" />
                  <span className="flex-1 truncate">{f.name}</span>
                  {selectedFamily?.id === f.id && <Check size={15} className="text-teal-600" />}
                </button>
              ))}
            </div>
          )}

          <div className="pt-1 border-t border-gray-100">
            <button
              type="button"
              role="menuitem"
              onClick={handleLogout}
              className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-red-600 hover:bg-red-50 text-left"
            >
              <LogOut size={16} className="flex-shrink-0" />
              Se déconnecter
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
