import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { fetchGoogleNonce, loadGoogleClientId, loadGoogleScript } from "../../lib/google";

// Identifiant client Google : undefined (chargement), null (désactivé) ou la valeur.
export function useGoogleClientId() {
  const [clientId, setClientId] = useState(undefined);
  useEffect(() => {
    let alive = true;
    loadGoogleClientId().then((id) => alive && setClientId(id));
    return () => {
      alive = false;
    };
  }, []);
  return clientId;
}

// Bouton OFFICIEL « Continuer avec Google » (rendu par Google : thème outline,
// texte « continue_with », en français). Rien n'est affiché si la connexion
// Google n'est pas activée sur le serveur. `onCredential(credential)` reçoit
// le jeton d'identité, à envoyer TEL QUEL au serveur qui le vérifie (jamais lu
// ici). Après chaque tentative, le bouton est réinitialisé avec un nouveau
// nonce (chacun ne sert qu'une fois). `separator` : ligne « ou » au-dessus.
export function GoogleButton({ onCredential, separator = false, label }) {
  const clientId = useGoogleClientId();
  const containerRef = useRef(null);
  const handlerRef = useRef(onCredential);
  handlerRef.current = onCredential;
  const [round, setRound] = useState(0);
  const [busy, setBusy] = useState(false);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    if (!clientId) return undefined;
    let alive = true;
    (async () => {
      try {
        const [google, nonce] = await Promise.all([loadGoogleScript(), fetchGoogleNonce()]);
        const container = containerRef.current;
        if (!alive || !container) return;
        google.accounts.id.initialize({
          client_id: clientId,
          nonce,
          ux_mode: "popup",
          auto_select: false,
          cancel_on_tap_outside: true,
          callback: async ({ credential }) => {
            if (!alive) return;
            setBusy(true);
            try {
              await handlerRef.current(credential);
            } finally {
              if (alive) {
                setBusy(false);
                setRound((r) => r + 1);
              }
            }
          },
        });
        container.innerHTML = "";
        google.accounts.id.renderButton(container, {
          type: "standard",
          theme: "outline",
          size: "large",
          text: "continue_with",
          shape: "rectangular",
          logo_alignment: "center",
          locale: "fr",
          width: Math.max(200, Math.min(400, Math.floor(container.offsetWidth || 320))),
        });
        setUnavailable(false);
      } catch {
        if (alive) setUnavailable(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [clientId, round]);

  if (!clientId) return null;

  return (
    <div>
      {separator && (
        <div className="flex items-center gap-3 my-5" aria-hidden="true">
          <div className="flex-1 h-px bg-gray-200" />
          <span className="text-xs font-medium text-gray-400 uppercase">ou</span>
          <div className="flex-1 h-px bg-gray-200" />
        </div>
      )}
      {label && <p className="text-sm text-gray-600 text-center mb-2">{label}</p>}
      <div className={`relative ${busy ? "opacity-50 pointer-events-none" : ""}`}>
        <div ref={containerRef} className="w-full flex justify-center min-h-[44px]" />
        {busy && (
          <div className="absolute inset-0 flex items-center justify-center">
            <Loader2 className="animate-spin text-teal-600" size={22} />
          </div>
        )}
      </div>
      {unavailable && (
        <p className="text-xs text-gray-500 text-center mt-2">
          Connexion avec Google indisponible pour le moment (vérifiez votre connexion Internet).
        </p>
      )}
    </div>
  );
}
