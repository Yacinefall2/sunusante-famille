import { useLocation } from "react-router-dom";
import { NotificationBell } from "../notifications/NotificationBell";
import { UserMenu } from "./UserMenu";

const pageTitles = {
  "/dashboard": { title: "Tableau de bord", subtitle: "Vue d'ensemble de la famille" },
  "/membres": { title: "Membres de la famille", subtitle: "Les personnes du foyer, avec ou sans compte" },
  "/fiches": { title: "Fiches médicales", subtitle: "Dossiers médicaux des membres" },
  "/rendez-vous": { title: "Rendez-vous médicaux", subtitle: "Planifiez et suivez vos consultations" },
  "/traitements": { title: "Traitements & Médicaments", subtitle: "Historique des traitements en cours" },
  "/vaccinations": { title: "Carnet de vaccinations", subtitle: "Suivi du calendrier vaccinal" },
  "/documents": { title: "Documents médicaux", subtitle: "Ordonnances, résultats et bilans" },
  "/famille": { title: "Comptes & invitations", subtitle: "Comptes de la famille, rôles et invitations" },
  "/village": { title: "Village", subtitle: "Proches non connectés et rappels relayés" },
  "/partage": { title: "Partage & urgence", subtitle: "Lien médecin et fiche d'urgence" },
  "/compte": { title: "Mon compte", subtitle: "Nom, adresse, mot de passe et données" },
  "/notifications": { title: "Notifications", subtitle: "Rappels et préférences" },
  "/journal": { title: "Journal d'activité", subtitle: "Qui a fait quoi, et quand" },
};

export function Topbar() {
  const { pathname } = useLocation();
  const pageKey = Object.keys(pageTitles).find((k) => pathname.startsWith(k)) ?? "/dashboard";
  const page = pageTitles[pageKey] ?? { title: "SunuSanté Famille", subtitle: "" };

  return (
    <header className="h-16 bg-white border-b border-gray-100 flex items-center justify-between px-6 sticky top-0 z-30">
      <div className="pl-10 lg:pl-0">
        <h1 className="text-lg font-bold text-gray-800">{page.title}</h1>
        <p className="text-xs text-gray-500 hidden sm:block">{page.subtitle}</p>
      </div>
      <div className="flex items-center gap-3">
        <NotificationBell />
        <UserMenu />
      </div>
    </header>
  );
}