import { Link } from "react-router-dom";
import { Badge } from "../components/ui/Badge";
import { formatDateTime } from "../lib/utils";
import { STATUS_LABELS, STATUS_VARIANTS, TYPE_LABELS } from "./api";

// Fiche d'un compte vue par le support : MÉTADONNÉES SEULEMENT (jamais de
// fiche médicale, de rendez-vous, de traitement, de document…).
function Row({ label, children }) {
  return (
    <div className="flex flex-wrap gap-x-3 py-1.5 border-b border-slate-100 last:border-0 text-sm">
      <dt className="w-52 text-slate-500 flex-shrink-0">{label}</dt>
      <dd className="flex-1 min-w-0 break-words">{children}</dd>
    </div>
  );
}

export function AccountMeta({ account, showLink = false }) {
  if (!account) return <p className="text-sm text-slate-500">Aucun compte rattaché (adresse inconnue ou compte supprimé).</p>;
  return (
    <dl>
      <Row label="Nom">
        {showLink ? (
          <Link to={`/admin/comptes/${account.id}`} className="underline font-semibold">
            {account.name}
          </Link>
        ) : (
          <strong>{account.name}</strong>
        )}
      </Row>
      <Row label="Adresse courriel">
        {account.email}{" "}
        <Badge variant={account.emailVerified ? "success" : "warning"}>{account.emailVerified ? "vérifiée" : "non vérifiée"}</Badge>
      </Row>
      <Row label="Créé le">{formatDateTime(account.createdAt)}</Row>
      <Row label="Dernière connexion">{account.lastLoginAt ? formatDateTime(account.lastLoginAt) : "—"}</Row>
      <Row label="Échecs de connexion (24 h)">
        {account.failedLogins24h}
        {account.currentLoginFailures > 0 && <span className="text-slate-500"> · {account.currentLoginFailures} dans la fenêtre en cours</span>}
      </Row>
      <Row label="Sessions ouvertes">{account.openSessions}</Row>
      <Row label="Appareils (notifications push)">{account.pushDevices}</Row>
      <Row label="Familles">
        {account.families.length === 0 ? (
          "—"
        ) : (
          <ul className="space-y-0.5">
            {account.families.map((f) => (
              <li key={f.familyId}>
                {f.name} — {f.roleLabel}
              </li>
            ))}
          </ul>
        )}
      </Row>
      <Row label="Suspension">
        {account.suspension ? (
          <span className="text-red-700">
            Suspendu depuis le {formatDateTime(account.suspension.suspendedAt)},{" "}
            {account.suspension.suspendedUntil ? `jusqu'au ${formatDateTime(account.suspension.suspendedUntil)}` : "jusqu'à nouvel ordre"}
            {account.suspension.reason && <span className="block text-slate-600">Motif : {account.suspension.reason}</span>}
          </span>
        ) : (
          "Actif"
        )}
      </Row>
      <Row label="Demandes liées">
        {account.requests.length === 0 ? (
          "—"
        ) : (
          <ul className="space-y-0.5">
            {account.requests.map((r) => (
              <li key={r.id}>
                <Link to={`/admin/demandes/${r.id}`} className="underline">
                  {r.reference}
                </Link>{" "}
                {TYPE_LABELS[r.type]} <Badge variant={STATUS_VARIANTS[r.status]}>{STATUS_LABELS[r.status]}</Badge>
              </li>
            ))}
          </ul>
        )}
      </Row>
    </dl>
  );
}
