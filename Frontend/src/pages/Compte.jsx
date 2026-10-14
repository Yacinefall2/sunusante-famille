import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AppShell } from "../components/layout/AppShell";
import { Modal } from "../components/ui/Modal";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { useAuth } from "../context/AuthContext";
import { useFamily } from "../context/FamilyContext";
import { UserRound, Mail, KeyRound, Download, FileDown, Trash2, Loader2, AlertTriangle, Clock, RotateCw, ZoomIn, Smartphone, LifeBuoy, Link2 } from "lucide-react";
import { Switch } from "../components/ui/Switch";
import { SoundAlertsSetup } from "../components/senior/SoundAlertsSetup";
import { InstallAppButton } from "../components/pwa/InstallAppButton";
import { formatDate } from "../lib/utils";
import { openPrivateLink } from "../lib/session";
import { postGoogle } from "../lib/google";
import { GoogleButton, useGoogleClientId } from "../components/auth/GoogleButton";
import toast from "react-hot-toast";

const MIN_PASSWORD_LENGTH = 8;

function Section({ icon: Icon, title, hint, children, danger }) {
  return (
    <section className={`bg-white rounded-2xl shadow-sm border p-6 ${danger ? "border-red-100" : "border-gray-100"}`}>
      <div className="flex items-start gap-3 mb-4">
        <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${danger ? "bg-red-50" : "bg-teal-50"}`}>
          <Icon size={18} className={danger ? "text-red-500" : "text-teal-600"} />
        </div>
        <div>
          <h3 className="font-bold text-gray-800">{title}</h3>
          {hint && <p className="text-xs text-gray-500 mt-0.5">{hint}</p>}
        </div>
      </div>
      {children}
    </section>
  );
}

async function send(url, method, body) {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Erreur");
  return data;
}

export default function ComptePage() {
  const { refreshUser, seniorMode, setSeniorMode } = useAuth();
  // Sa propre fiche dans la famille sélectionnée (export PDF du dossier).
  const { myMember } = useFamily();
  const [savingDisplay, setSavingDisplay] = useState(false);
  const navigate = useNavigate();
  const [account, setAccount] = useState(null);
  const [name, setName] = useState("");
  const [savingName, setSavingName] = useState(false);
  const [emailForm, setEmailForm] = useState({ newEmail: "", password: "" });
  const [savingEmail, setSavingEmail] = useState(false);
  const [pwForm, setPwForm] = useState({ password: "", newPassword: "", confirm: "" });
  const [savingPw, setSavingPw] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  const [deleteForm, setDeleteForm] = useState({ password: "", deleteMyFiche: false, confirmText: "" });
  const [deleting, setDeleting] = useState(false);
  // Connexion avec Google (section « Connexion avec Google »).
  const googleClientId = useGoogleClientId();
  const [unlinkPassword, setUnlinkPassword] = useState("");
  const [unlinking, setUnlinking] = useState(false);
  const [settingUpPassword, setSettingUpPassword] = useState(false);

  // Erreur de chargement : affichée avec un bouton « Réessayer » au lieu
  // d'un chargement sans fin.
  const [loadError, setLoadError] = useState(false);

  const load = async () => {
    setLoadError(false);
    try {
      const res = await fetch("/api/account");
      if (!res.ok) throw new Error();
      const data = await res.json();
      setAccount(data);
      setName(data.name);
    } catch {
      setLoadError(true);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const saveName = async () => {
    setSavingName(true);
    try {
      await send("/api/account/profile", "PUT", { name });
      toast.success("Nom enregistré");
      refreshUser();
      load();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSavingName(false);
    }
  };

  // Mode senior (UC-25) : réglage d'affichage, sans effet sur les droits.
  const toggleSenior = async (on) => {
    setSavingDisplay(true);
    try {
      await setSeniorMode(on);
      toast.success(on ? "Mode senior activé : grands caractères et accueil simplifié" : "Mode senior désactivé");
      load();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSavingDisplay(false);
    }
  };

  const changeEmail = async () => {
    setSavingEmail(true);
    try {
      const data = await send("/api/account/email", "POST", emailForm);
      toast.success(`Lien de confirmation envoyé à ${data.pendingEmail}`);
      setEmailForm({ newEmail: "", password: "" });
      load();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSavingEmail(false);
    }
  };

  const pwTooShort = pwForm.newPassword.length > 0 && pwForm.newPassword.length < MIN_PASSWORD_LENGTH;
  const pwMismatch = pwForm.confirm.length > 0 && pwForm.confirm !== pwForm.newPassword;
  const pwReady = pwForm.password && pwForm.newPassword.length >= MIN_PASSWORD_LENGTH && pwForm.newPassword === pwForm.confirm;

  const changePassword = async () => {
    setSavingPw(true);
    try {
      await send("/api/account/password", "POST", { password: pwForm.password, newPassword: pwForm.newPassword });
      toast.success("Mot de passe modifié : vos autres appareils ont été déconnectés");
      setPwForm({ password: "", newPassword: "", confirm: "" });
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSavingPw(false);
    }
  };

  // Lier son compte Google : même adresse que le compte exigée (serveur).
  const linkGoogle = async (credential) => {
    const { ok, data } = await postGoogle("/api/account/google", { credential }, { authRefresh: true });
    if (!ok) {
      toast.error(data.error || "Liaison avec Google impossible");
      return;
    }
    toast.success("Compte Google lié : vous pouvez vous connecter avec « Continuer avec Google »");
    load();
  };

  const unlinkGoogle = async () => {
    setUnlinking(true);
    try {
      await send("/api/account/google", "DELETE", { password: unlinkPassword });
      toast.success("Connexion avec Google retirée");
      setUnlinkPassword("");
      load();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setUnlinking(false);
    }
  };

  // Compte créé avec Google : un lien pour choisir un mot de passe part à
  // l'adresse du compte (même mécanisme que « Mot de passe oublié »).
  const setupPassword = async () => {
    setSettingUpPassword(true);
    try {
      const data = await send("/api/account/password-setup", "POST");
      toast.success(`Lien envoyé à ${data.sentTo} : suivez-le pour choisir votre mot de passe`);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSettingUpPassword(false);
    }
  };

  const deleteAccount = async () => {
    setDeleting(true);
    try {
      await send("/api/account", "DELETE", { password: deleteForm.password, deleteMyFiche: deleteForm.deleteMyFiche });
      toast.success("Votre compte a été supprimé");
      await refreshUser();
      navigate("/login");
    } catch (e) {
      toast.error(e.message);
    } finally {
      setDeleting(false);
    }
  };

  if (!account && loadError) {
    return (
      <AppShell>
        <div className="max-w-md mx-auto text-center py-20">
          <AlertTriangle className="text-amber-500 mx-auto mb-3" size={32} />
          <p className="text-gray-700 font-semibold mb-1">Impossible de charger votre compte</p>
          <p className="text-sm text-gray-500 mb-5">Vérifiez votre connexion Internet puis réessayez.</p>
          <Button onClick={load}>
            <RotateCw size={15} />
            Réessayer
          </Button>
        </div>
      </AppShell>
    );
  }

  if (!account) {
    return (
      <AppShell>
        <div className="flex justify-center py-20">
          <Loader2 className="animate-spin text-teal-600" size={36} />
        </div>
      </AppShell>
    );
  }

  const blocking = account.families.filter((f) => f.isPrimaryAdmin && f.otherAccounts > 0);
  // Compte créé avec Google sans mot de passe : les actions qui demandent le
  // mot de passe actuel attendent qu'il en ait défini un.
  const noPassword = !account.hasPassword;
  const noPasswordNote = (
    <p className="text-sm text-gray-700 bg-gray-50 rounded-xl p-3">
      Votre compte a été créé avec Google et n'a pas encore de mot de passe. Pour cette action, définissez-en un
      d'abord (section « Mot de passe »).
    </p>
  );
  const soleAdminOf = account.families.filter((f) => f.isPrimaryAdmin && f.otherAccounts === 0);

  return (
    <AppShell>
      <div className="max-w-2xl space-y-5">
        <div>
          <h2 className="text-xl font-bold text-gray-800">Mon compte</h2>
          <p className="text-sm text-gray-500">Compte créé le {formatDate(account.createdAt)}</p>
        </div>

        <Section icon={UserRound} title="Mon nom" hint="Affiché aux autres membres de la famille.">
          <div className="flex flex-col sm:flex-row gap-3 sm:items-end">
            <div className="flex-1">
              <Input label="Nom" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <Button onClick={saveName} loading={savingName} disabled={!name.trim() || name.trim() === account.name}>
              Enregistrer
            </Button>
          </div>
        </Section>

        <Section
          icon={ZoomIn}
          title="Affichage"
          hint="Le mode senior agrandit l'affichage : il ne change rien à vos droits ni aux dossiers auxquels vous avez accès."
        >
          <div className="flex items-start gap-4">
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-gray-800">Mode senior</p>
              <p className="text-sm text-gray-600">
                Grands caractères, accueil simplifié à grands boutons et alertes sonores pour les médicaments et les
                rendez-vous.
              </p>
              {account.seniorModeSetBy && (
                <p className="text-sm text-teal-700 mt-1">
                  {seniorMode ? "Activé" : "Désactivé"} par {account.seniorModeSetBy}
                  {account.seniorModeUpdatedAt ? ` le ${formatDate(account.seniorModeUpdatedAt)}` : ""}. Vous pouvez le
                  changer à tout moment.
                </p>
              )}
            </div>
            <Switch checked={seniorMode} onChange={toggleSenior} disabled={savingDisplay} label="Mode senior" />
          </div>
          {seniorMode && (
            <div className="mt-4 pt-4 border-t border-gray-100">
              <p className="font-semibold text-gray-800 mb-2">Alertes sonores</p>
              <SoundAlertsSetup />
            </div>
          )}
        </Section>

        <Section
          icon={Smartphone}
          title="Application sur cet appareil"
          hint="Installez SunuSanté Famille sur l'écran d'accueil de votre téléphone ou de votre ordinateur."
        >
          <InstallAppButton />
        </Section>

        <Section icon={Mail} title="Adresse courriel" hint="Pour vous connecter et recevoir les rappels.">
          <p className="text-sm text-gray-700 mb-3">
            Adresse actuelle : <strong className="break-all">{account.email}</strong>
          </p>
          {account.pendingEmail && (
            <p className="text-sm text-amber-800 bg-amber-50 border border-amber-100 rounded-xl px-3 py-2 mb-3 flex items-start gap-2">
              <Clock size={15} className="mt-0.5 flex-shrink-0" />
              <span>
                En attente de confirmation : <strong className="break-all">{account.pendingEmail}</strong>. Cliquez sur le
                lien reçu à cette adresse pour terminer le changement.
              </span>
            </p>
          )}
          {noPassword ? (
            noPasswordNote
          ) : (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Input
                  label="Nouvelle adresse"
                  type="email"
                  value={emailForm.newEmail}
                  onChange={(e) => setEmailForm((p) => ({ ...p, newEmail: e.target.value }))}
                  placeholder="vous@exemple.com"
                />
                <Input
                  label="Mot de passe actuel"
                  type="password"
                  autoComplete="current-password"
                  value={emailForm.password}
                  onChange={(e) => setEmailForm((p) => ({ ...p, password: e.target.value }))}
                />
              </div>
              <p className="text-xs text-gray-500 mt-2">
                Un lien de confirmation part vers la nouvelle adresse ; l'ancienne reste active jusqu'à ce qu'il soit suivi.
              </p>
              <Button
                className="mt-3"
                onClick={changeEmail}
                loading={savingEmail}
                disabled={!emailForm.newEmail.trim() || !emailForm.password}
              >
                Changer d'adresse
              </Button>
            </>
          )}
        </Section>

        <Section icon={KeyRound} title="Mot de passe" hint="Changer de mot de passe déconnecte vos autres appareils.">
          {noPassword ? (
            <div>
              <p className="text-sm text-gray-700 mb-3">
                Votre compte a été créé avec Google : il n'a pas de mot de passe. Vous pouvez en définir un pour vous
                connecter aussi avec votre adresse : un lien vous est envoyé à <strong className="break-all">{account.email}</strong>.
              </p>
              <Button onClick={setupPassword} loading={settingUpPassword}>
                <KeyRound size={15} />
                Définir un mot de passe
              </Button>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <Input
                  label="Mot de passe actuel"
                  type="password"
                  autoComplete="current-password"
                  value={pwForm.password}
                  onChange={(e) => setPwForm((p) => ({ ...p, password: e.target.value }))}
                />
                <Input
                  label="Nouveau"
                  type="password"
                  autoComplete="new-password"
                  value={pwForm.newPassword}
                  onChange={(e) => setPwForm((p) => ({ ...p, newPassword: e.target.value }))}
                  error={pwTooShort ? `${MIN_PASSWORD_LENGTH} caractères minimum` : undefined}
                />
                <Input
                  label="Confirmer"
                  type="password"
                  autoComplete="new-password"
                  value={pwForm.confirm}
                  onChange={(e) => setPwForm((p) => ({ ...p, confirm: e.target.value }))}
                  error={pwMismatch ? "Ne correspond pas" : undefined}
                />
              </div>
              <Button className="mt-3" onClick={changePassword} loading={savingPw} disabled={!pwReady}>
                Changer le mot de passe
              </Button>
            </>
          )}
        </Section>

        {(account.googleLinked || googleClientId) && (
          <Section
            icon={Link2}
            title="Connexion avec Google"
            hint="Se connecter en un clic avec le compte Google de la même adresse."
          >
            {account.googleLinked ? (
              <div className="space-y-3">
                <p className="text-sm text-gray-700">
                  Votre compte est lié à Google
                  {account.googleLinkedAt ? ` depuis le ${formatDate(account.googleLinkedAt)}` : ""} : vous pouvez vous
                  connecter avec « Continuer avec Google ».
                </p>
                {noPassword ? (
                  <p className="text-sm text-gray-700 bg-gray-50 rounded-xl p-3">
                    Pour délier Google, définissez d'abord un mot de passe (section « Mot de passe ») : sans lui, vous ne
                    pourriez plus vous connecter.
                  </p>
                ) : (
                  <div className="flex flex-col sm:flex-row gap-3 sm:items-end">
                    <div className="flex-1">
                      <Input
                        label="Mot de passe actuel"
                        type="password"
                        autoComplete="current-password"
                        value={unlinkPassword}
                        onChange={(e) => setUnlinkPassword(e.target.value)}
                      />
                    </div>
                    <Button variant="outline" onClick={unlinkGoogle} loading={unlinking} disabled={!unlinkPassword}>
                      Délier Google
                    </Button>
                  </div>
                )}
              </div>
            ) : (
              <div className="max-w-sm">
                <p className="text-sm text-gray-700 mb-3">
                  Utilisez le compte Google de <strong className="break-all">{account.email}</strong>.
                </p>
                <GoogleButton onCredential={linkGoogle} />
              </div>
            )}
          </Section>
        )}

        <Section
          icon={Download}
          title="Mes données"
          hint="Votre dossier médical en PDF (à imprimer ou à montrer à un médecin), ou une copie complète de votre compte et de votre fiche au format JSON."
        >
          <div className="flex flex-col sm:flex-row gap-3">
            {/* Dossier médical en PDF (UC-27) : sa propre fiche dans la famille sélectionnée */}
            {myMember && (
              <a
                href={`/api/members/${myMember.id}/export.pdf`}
                download
                onClick={openPrivateLink}
                className="inline-flex items-center justify-center gap-2 font-semibold rounded-xl transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-offset-2 text-sm px-4 py-2.5 bg-teal-600 hover:bg-teal-700 text-white focus:ring-teal-500 shadow-sm"
              >
                <FileDown size={15} />
                Exporter mon dossier en PDF
              </a>
            )}
            <a
              href="/api/account/export"
              download
              onClick={openPrivateLink}
              className="inline-flex items-center justify-center gap-2 font-semibold rounded-xl transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-offset-2 text-sm px-4 py-2.5 border-2 border-teal-600 text-teal-600 hover:bg-teal-50 focus:ring-teal-500"
            >
              <Download size={15} />
              Télécharger mes données (JSON)
            </a>
          </div>
        </Section>

        <Section
          icon={LifeBuoy}
          title="Contacter le support"
          hint="Une question, ou faire supprimer vos données par le support. Le support n'a jamais accès aux dossiers de santé."
        >
          <Link
            to="/support"
            className="inline-flex items-center justify-center gap-2 font-semibold rounded-xl transition-all duration-200 text-sm px-4 py-2.5 border-2 border-teal-600 text-teal-600 hover:bg-teal-50"
          >
            <LifeBuoy size={15} />
            Contacter le support · Mes demandes
          </Link>
        </Section>

        <Section icon={Trash2} title="Supprimer mon compte" hint="Action définitive." danger>
          {blocking.length > 0 ? (
            <p className="text-sm text-gray-700 bg-gray-50 rounded-xl p-3">
              Vous administrez <strong>{blocking.map((f) => f.name).join(", ")}</strong>, qui compte d'autres comptes.
              Retirez-les depuis « Comptes & invitations », ou supprimez l'espace familial (même page, « Zone sensible »),
              avant de supprimer votre compte.
            </p>
          ) : (
            <Button variant="ghost" className="text-red-600 hover:bg-red-50" onClick={() => setShowDelete(true)}>
              <Trash2 size={15} />
              Supprimer mon compte
            </Button>
          )}
        </Section>
      </div>

      <Modal open={showDelete} onClose={() => setShowDelete(false)} title="Supprimer mon compte">
        <div className="space-y-4">
          <div className="flex items-start gap-3 bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-800">
            <AlertTriangle size={18} className="flex-shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="font-semibold">Votre compte sera supprimé définitivement.</p>
              {soleAdminOf.length > 0 && (
                <p>
                  Vous êtes le seul compte de <strong>{soleAdminOf.map((f) => f.name).join(", ")}</strong> : l'espace, toutes
                  ses fiches et tous ses documents seront supprimés aussi.
                </p>
              )}
            </div>
          </div>

          <label className="flex items-start gap-3 p-3 rounded-xl border border-gray-200 cursor-pointer">
            <input
              type="checkbox"
              className="mt-1 w-4 h-4"
              checked={deleteForm.deleteMyFiche}
              onChange={(e) => setDeleteForm((p) => ({ ...p, deleteMyFiche: e.target.checked }))}
            />
            <span className="text-sm text-gray-700">
              <span className="font-semibold block">Effacer aussi ma fiche médicale</span>
              Sinon, elle reste à la famille comme celle d'un proche sans compte. Possible seulement si vous êtes majeur(e).
            </span>
          </label>

          {noPassword ? (
            noPasswordNote
          ) : (
            <Input
              label="Mot de passe actuel"
              type="password"
              autoComplete="current-password"
              value={deleteForm.password}
              onChange={(e) => setDeleteForm((p) => ({ ...p, password: e.target.value }))}
            />
          )}
          <Input
            label="Tapez SUPPRIMER pour confirmer"
            value={deleteForm.confirmText}
            onChange={(e) => setDeleteForm((p) => ({ ...p, confirmText: e.target.value }))}
          />

          <div className="flex gap-3 pt-2">
            <Button variant="ghost" onClick={() => setShowDelete(false)} className="flex-1">
              Annuler
            </Button>
            <Button
              onClick={deleteAccount}
              loading={deleting}
              disabled={!deleteForm.password || deleteForm.confirmText.trim().toUpperCase() !== "SUPPRIMER"}
              className="flex-1 bg-red-600 hover:bg-red-700"
            >
              Supprimer définitivement
            </Button>
          </div>
        </div>
      </Modal>
    </AppShell>
  );
}
