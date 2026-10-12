import { Link, useLocation } from "react-router-dom";
import {
  LayoutDashboard,
  Users,
  FileHeart,
  Calendar,
  Pill,
  Syringe,
  FileText,
  Heart,
  Menu,
  X,
  ChevronRight,
  UserCog,
  Bell,
  TreePine,
  ShieldPlus,
  ScrollText,
  Home,
  MoreHorizontal,
  ChevronUp,
} from "lucide-react";
import { cn } from "../../lib/utils";
import { useEffect, useState } from "react";
import { useAuth } from "../../context/AuthContext";
import { useFamily } from "../../context/FamilyContext";

const navItems = [
  { href: "/dashboard", label: "Tableau de bord", icon: LayoutDashboard },
  { href: "/membres", label: "Membres", icon: Users },
  { href: "/fiches", label: "Fiches médicales", icon: FileHeart },
  { href: "/rendez-vous", label: "Rendez-vous", icon: Calendar },
  { href: "/traitements", label: "Traitements", icon: Pill },
  { href: "/vaccinations", label: "Vaccinations", icon: Syringe },
  { href: "/documents", label: "Documents", icon: FileText },
  { href: "/partage", label: "Partage & urgence", icon: ShieldPlus },
  { href: "/village", label: "Village", icon: TreePine },
  { href: "/famille", label: "Comptes & invitations", icon: UserCog },
  { href: "/notifications", label: "Notifications", icon: Bell },
  { href: "/journal", label: "Journal d'activité", icon: ScrollText },
];

// Menu réduit du mode senior (UC-25) : l'essentiel, en grand ; « Plus »
// déplie le menu complet.
const seniorNavItems = (myMember) =>
  [
    { href: "/dashboard", label: "Accueil", icon: Home },
    { href: "/traitements", label: "Mes médicaments", icon: Pill },
    { href: "/rendez-vous", label: "Mes rendez-vous", icon: Calendar },
    myMember && { href: `/partage?fiche=${myMember.id}`, label: "Ma fiche d'urgence", icon: ShieldPlus },
  ].filter(Boolean);

// Menu complet déplié en mode senior : gardé d'une page à l'autre (la barre
// latérale est recréée à chaque page).
const FULL_MENU_KEY = "sunusante.menuComplet";
const readFullMenu = () => {
  try {
    return sessionStorage.getItem(FULL_MENU_KEY) === "1";
  } catch {
    return false;
  }
};

export function Sidebar() {
  const { pathname } = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const { seniorMode } = useAuth();
  const { myMember } = useFamily();
  const [fullMenu, setFullMenu] = useState(readFullMenu);
  const toggleFullMenu = () => {
    setFullMenu((v) => {
      try {
        sessionStorage.setItem(FULL_MENU_KEY, v ? "0" : "1");
      } catch {
        // mémoire de la page seulement
      }
      return !v;
    });
  };

  // Menu mobile ouvert : la touche Échap le referme.
  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (e) => e.key === "Escape" && setMobileOpen(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [mobileOpen]);

  const NavLink = ({ item }) => {
    const Icon = item.icon;
    const active = pathname.startsWith(item.href.split("?")[0]);
    const big = seniorMode && item.senior;
    return (
      <Link
        to={item.href}
        onClick={() => setMobileOpen(false)}
        className={cn(
          "flex items-center gap-3 px-4 py-3 rounded-xl font-medium text-sm transition-all duration-200 group",
          big && "text-lg font-semibold py-4 border-2 border-transparent",
          big && !active && "border-gray-200",
          active
            ? "bg-teal-600 text-white shadow-md shadow-teal-200"
            : "text-gray-600 hover:bg-teal-50 hover:text-teal-700"
        )}
      >
        <Icon
          size={big ? 28 : 20}
          className={cn("flex-shrink-0", active ? "text-white" : big ? "text-teal-700" : "text-gray-400 group-hover:text-teal-600")}
        />
        <span className="flex-1">{item.label}</span>
        {active && <ChevronRight size={16} className="opacity-70" />}
      </Link>
    );
  };

  return (
    <>
      {/* Mobile hamburger */}
      <button
        type="button"
        onClick={() => setMobileOpen(true)}
        aria-label="Ouvrir le menu"
        aria-expanded={mobileOpen}
        className="lg:hidden fixed top-4 left-4 z-50 p-2.5 bg-white rounded-xl shadow-lg border border-gray-100"
      >
        <Menu size={22} className="text-teal-600" />
      </button>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div className="lg:hidden fixed inset-0 bg-black/40 z-40" onClick={() => setMobileOpen(false)} />
      )}

      {/* Sidebar */}
      <aside
        className={cn(
          "fixed top-0 left-0 h-full w-64 bg-white border-r border-gray-100 z-50 flex flex-col",
          "shadow-xl transition-transform duration-300",
          "lg:translate-x-0 lg:shadow-none",
          mobileOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"
        )}
      >
        {/* Logo */}
        <div className="px-6 py-5 border-b border-gray-100 flex items-center justify-between">
          <Link to="/dashboard" className="flex items-center gap-2.5" onClick={() => setMobileOpen(false)}>
            <div className="w-9 h-9 bg-gradient-to-br from-teal-500 to-blue-600 rounded-xl flex items-center justify-center shadow-md">
              <Heart size={18} className="text-white" />
            </div>
            <div>
              <span className="text-lg font-bold text-gray-800">SunuSanté</span>{" "}
              <span className="text-lg font-bold text-teal-600">Famille</span>
            </div>
          </Link>
          <button
            type="button"
            onClick={() => setMobileOpen(false)}
            aria-label="Fermer le menu"
            className="lg:hidden p-1 rounded-lg hover:bg-gray-100 text-gray-500">
            <X size={18} />
          </button>
        </div>

        {/* Nav */}
        {seniorMode ? (
          <nav className="flex-1 px-4 py-4 space-y-2 overflow-y-auto" aria-label="Menu simplifié">
            {seniorNavItems(myMember).map((item) => (
              <NavLink key={item.href} item={{ ...item, senior: true }} />
            ))}
            <button
              type="button"
              onClick={toggleFullMenu}
              aria-expanded={fullMenu}
              className="w-full flex items-center gap-3 px-4 py-4 rounded-xl text-lg font-semibold text-gray-800 border-2 border-gray-200 hover:bg-gray-50"
            >
              {fullMenu ? <ChevronUp size={28} className="text-teal-700" /> : <MoreHorizontal size={28} className="text-teal-700" />}
              <span className="flex-1 text-left">{fullMenu ? "Moins" : "Plus"}</span>
            </button>
            {fullMenu && (
              <div className="pt-2 mt-2 border-t-2 border-gray-200 space-y-1">
                {navItems.map((item) => (
                  <NavLink key={item.href} item={item} />
                ))}
              </div>
            )}
          </nav>
        ) : (
          <nav className="flex-1 px-4 py-4 space-y-1 overflow-y-auto">
            {navItems.map((item) => (
              <NavLink key={item.href} item={item} />
            ))}
          </nav>
        )}

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-100">
          <p className="text-xs text-gray-400 text-center">
            © {new Date().getFullYear()} SunuSanté Famille
            <br />
            Votre santé, notre priorité
          </p>
        </div>
      </aside>
    </>
  );
}