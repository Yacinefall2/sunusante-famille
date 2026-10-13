import { Link } from "react-router-dom";
import { CheckCircle2, Download, Share, SquarePlus } from "lucide-react";
import toast from "react-hot-toast";
import { Button } from "../ui/Button";
import { promptInstall, useInstallState } from "../../lib/pwa";

// Instructions iPhone / iPad : Safari n'a pas de bouton d'installation, on
// passe par le menu Partager.
function IosInstructions() {
  return (
    <div className="rounded-xl border border-gray-200 bg-gray-50 p-4 text-sm text-gray-700 space-y-2">
      <p className="font-semibold text-gray-800">Sur iPhone ou iPad :</p>
      <ol className="space-y-1.5 list-decimal pl-5">
        <li>
          ouvrez SunuSanté Famille dans <strong>Safari</strong> ;
        </li>
        <li>
          touchez <strong>Partager</strong> <Share size={14} className="inline -mt-1 text-blue-600" aria-hidden="true" /> ;
        </li>
        <li>
          choisissez <strong>« Sur l&apos;écran d&apos;accueil »</strong>{" "}
          <SquarePlus size={14} className="inline -mt-1" aria-hidden="true" />, puis <strong>Ajouter</strong>.
        </li>
      </ol>
    </div>
  );
}

const MENU_ITEM = "w-full flex items-center gap-3 px-4 py-2.5 text-sm text-gray-700 hover:bg-gray-50 text-left";

// Bouton « Installer l'application ». `variant` :
//  - "menu" : ligne du menu de l'avatar (rien si l'installation n'est pas
//    proposée ; sur iPhone, renvoie aux instructions de « Mon compte »)
//  - "section" : bloc de la page Mon compte, avec l'état de l'appareil
export function InstallAppButton({ variant = "section", onDone }) {
  const state = useInstallState();

  const install = async () => {
    onDone?.();
    const accepted = await promptInstall();
    if (accepted) toast.success("Application installée : retrouvez-la sur votre écran d'accueil");
  };

  if (variant === "menu") {
    if (state !== "available" && state !== "ios") return null;
    const content = (
      <>
        <Download size={16} className="text-gray-400 flex-shrink-0" />
        <span className="min-w-0">
          <span className="block">Installer l&apos;application</span>
          <span className="block text-xs text-gray-400">Sur l&apos;écran d&apos;accueil, consultable hors ligne</span>
        </span>
      </>
    );
    return state === "ios" ? (
      <Link to="/compte" role="menuitem" onClick={onDone} className={MENU_ITEM}>
        {content}
      </Link>
    ) : (
      <button type="button" role="menuitem" onClick={install} className={MENU_ITEM}>
        {content}
      </button>
    );
  }

  return (
    <div className="space-y-3">
      {state === "installed" ? (
        <p className="inline-flex items-center gap-2 text-sm font-semibold text-emerald-700">
          <CheckCircle2 size={18} /> L&apos;application est installée sur cet appareil.
        </p>
      ) : state === "ios" ? (
        <IosInstructions />
      ) : state === "available" ? (
        <Button onClick={install} offlineOk>
          <Download size={16} />
          Installer l&apos;application
        </Button>
      ) : (
        <p className="text-sm text-gray-600">
          Votre navigateur ne propose pas l&apos;installation directe : utilisez son menu (« Installer l&apos;application » ou
          « Ajouter à l&apos;écran d&apos;accueil »).
        </p>
      )}
      <p className="text-xs text-gray-500">
        Installée, SunuSanté Famille s&apos;ouvre comme une application, reste consultable sans réseau (données déjà
        consultées sur cet appareil, effacées à la déconnexion) et peut recevoir les rappels.
      </p>
    </div>
  );
}
