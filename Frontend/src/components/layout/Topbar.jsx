import { LogOut } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { NotificationBell } from "../notifications/NotificationBell";

const pageTitles = {
  "/dashboard": { title: "Tableau de bord", subtitle: "Vue d'ensemble de la famille" },
  "/membres": { title: "Membres de la famille", subtitle: "Gérez les profils médicaux" },
  "/rendez-vous": { title: "Rendez-vous médicaux", subtitle: "Planifiez et suivez vos consultations" },
  "/traitements": { title: "Traitements & Médicaments", subtitle: "Historique des traitements en cours" },
  "/vaccinations": { title: "Carnet de vaccinations", subtitle: "Suivi du calendrier vaccinal" },
  "/documents": { title: "Documents médicaux", subtitle: "Ordonnances, résultats et bilans" },
  "/famille": { title: "Accès & rôles", subtitle: "Comptes, rôles et invitations" },
  "/notifications": { title: "Notifications", subtitle: "Rappels et préférences" },
};

export function Topbar() {
  const { pathname } = useLocation();
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const pageKey = Object.keys(pageTitles).find((k) => pathname.startsWith(k)) ?? "/dashboard";
  const page = pageTitles[pageKey] ?? { title: "SunuSanté Famille", subtitle: "" };

  const initials = user?.name
    ? user.name
        .split(" ")
        .map((p) => p[0])
        .slice(0, 2)
        .join("")
        .toUpperCase()
    : "?";

  const handleLogout = async () => {
    await logout();
    navigate("/login");
  };

  return (
    <header className="h-16 bg-white border-b border-gray-100 flex items-center justify-between px-6 sticky top-0 z-30">
      <div className="pl-10 lg:pl-0">
        <h1 className="text-lg font-bold text-gray-800">{page.title}</h1>
        <p className="text-xs text-gray-500 hidden sm:block">{page.subtitle}</p>
      </div>
      <div className="flex items-center gap-3">
        <NotificationBell />
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl">
          <div className="w-8 h-8 bg-gradient-to-br from-teal-400 to-blue-500 rounded-full flex items-center justify-center text-white text-sm font-bold">
            {initials}
          </div>
          <span className="text-sm font-medium text-gray-700 hidden sm:block">{user?.name}</span>
        </div>
        <button
          onClick={handleLogout}
          title="Se déconnecter"
          className="p-2 rounded-xl hover:bg-red-50 text-gray-400 hover:text-red-500 transition-colors"
        >
          <LogOut size={18} />
        </button>
      </div>
    </header>
  );
}