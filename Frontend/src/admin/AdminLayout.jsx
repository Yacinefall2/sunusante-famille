import { NavLink } from "react-router-dom";
import { ShieldAlert, LayoutDashboard, Inbox, Users, ScrollText, History, LogOut } from "lucide-react";
import { useAdminAuth } from "./AdminAuthContext";
import { cn } from "../lib/utils";

const NAV = [
  { to: "/admin", label: "Accueil", icon: LayoutDashboard, end: true },
  { to: "/admin/demandes", label: "Demandes", icon: Inbox },
  { to: "/admin/comptes", label: "Comptes", icon: Users },
  { to: "/admin/journaux", label: "Journaux techniques", icon: ScrollText },
  { to: "/admin/audit", label: "Audit", icon: History },
];

// Bandeau permanent : rappel du cloisonnement, visible sur toutes les pages.
export function SupportBanner() {
  return (
    <div className="bg-amber-100 border-b border-amber-200 text-amber-900 text-sm font-semibold px-4 py-2 flex items-center gap-2 justify-center">
      <ShieldAlert size={16} className="flex-shrink-0" />
      Espace support — aucun accès au contenu médical
    </div>
  );
}

// Mise en page sobre de l'espace support, sans rien de l'application famille.
export function AdminLayout({ children }) {
  const { supportUser, logout } = useAdminAuth();
  return (
    <div className="min-h-screen bg-slate-50 text-slate-800">
      <SupportBanner />
      <header className="bg-slate-800 text-white">
        <div className="max-w-6xl mx-auto px-4 py-3 flex flex-wrap items-center gap-4">
          <p className="font-bold">SunuSanté Famille — Support</p>
          <nav className="flex flex-wrap gap-1 flex-1">
            {NAV.map(({ to, label, icon: Icon, end }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                className={({ isActive }) =>
                  cn("flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm", isActive ? "bg-slate-600" : "hover:bg-slate-700")
                }
              >
                <Icon size={15} />
                {label}
              </NavLink>
            ))}
          </nav>
          <div className="flex items-center gap-3 text-sm">
            <span className="text-slate-300">{supportUser?.name}</span>
            <button
              type="button"
              onClick={() => logout()}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600"
            >
              <LogOut size={15} />
              Se déconnecter
            </button>
          </div>
        </div>
      </header>
      <main className="max-w-6xl mx-auto px-4 py-6">{children}</main>
    </div>
  );
}

export function Card({ title, children, className, actions }) {
  return (
    <section className={cn("bg-white rounded-xl border border-slate-200 p-5", className)}>
      {(title || actions) && (
        <div className="flex items-center justify-between gap-3 mb-3">
          {title && <h2 className="font-bold text-slate-800">{title}</h2>}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}
