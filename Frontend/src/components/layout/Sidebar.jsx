import { Link, useLocation } from "react-router-dom";
import {
  LayoutDashboard,
  Users,
  Calendar,
  Pill,
  Syringe,
  FileText,
  Heart,
  Menu,
  X,
  ChevronRight,
  UserCog,
} from "lucide-react";
import { cn } from "../../lib/utils";
import { useState } from "react";

const navItems = [
  { href: "/dashboard", label: "Tableau de bord", icon: LayoutDashboard },
  { href: "/membres", label: "Membres", icon: Users },
  { href: "/rendez-vous", label: "Rendez-vous", icon: Calendar },
  { href: "/traitements", label: "Traitements", icon: Pill },
  { href: "/vaccinations", label: "Vaccinations", icon: Syringe },
  { href: "/documents", label: "Documents", icon: FileText },
  { href: "/famille", label: "Accès & rôles", icon: UserCog },
];

export function Sidebar() {
  const { pathname } = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);

  const NavLink = ({ item }) => {
    const Icon = item.icon;
    const active = pathname.startsWith(item.href);
    return (
      <Link
        to={item.href}
        onClick={() => setMobileOpen(false)}
        className={cn(
          "flex items-center gap-3 px-4 py-3 rounded-xl font-medium text-sm transition-all duration-200 group",
          active
            ? "bg-teal-600 text-white shadow-md shadow-teal-200"
            : "text-gray-600 hover:bg-teal-50 hover:text-teal-700"
        )}
      >
        <Icon size={20} className={cn("flex-shrink-0", active ? "text-white" : "text-gray-400 group-hover:text-teal-600")} />
        <span className="flex-1">{item.label}</span>
        {active && <ChevronRight size={16} className="opacity-70" />}
      </Link>
    );
  };

  return (
    <>
      {/* Mobile hamburger */}
      <button
        onClick={() => setMobileOpen(true)}
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
          <button onClick={() => setMobileOpen(false)} className="lg:hidden p-1 rounded-lg hover:bg-gray-100 text-gray-500">
            <X size={18} />
          </button>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-4 py-4 space-y-1 overflow-y-auto">
          {navItems.map((item) => (
            <NavLink key={item.href} item={item} />
          ))}
        </nav>

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