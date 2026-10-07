import { createContext, useContext, useState, useEffect, useCallback, useMemo } from "react";
import { useAuth } from "./AuthContext";

const FamilyContext = createContext(null);

export function FamilyProvider({ children }) {
  const { user } = useAuth();
  const [families, setFamilies] = useState([]);
  const [selectedFamily, setSelectedFamily] = useState(null);
  const [myRole, setMyRole] = useState(null); // "parent" | "adult" | "dependent" | null
  const [loading, setLoading] = useState(true);

  const loadFamilies = async () => {
    try {
      setLoading(true);
      const res = await fetch("/api/families");
      const data = await res.json();
      setFamilies(data);
      if (data.length > 0 && !selectedFamily) {
        setSelectedFamily(data[0]);
      }
    } finally {
      setLoading(false);
    }
  };

  // Charge le rôle (et la fiche liée éventuelle) de l'utilisateur connecté
  // dans la famille actuellement sélectionnée — nécessaire pour savoir quels
  // boutons afficher (modifier, supprimer, ajouter...) selon le rôle.
  const [myLinkedMemberId, setMyLinkedMemberId] = useState(null);
  // Vrai si l'utilisateur est l'administrateur familial (créateur de la famille)
  const [isPrimaryAdmin, setIsPrimaryAdmin] = useState(false);
  // Vrai une fois l'appartenance de l'utilisateur à la famille sélectionnée
  // chargée — évite d'afficher l'écran "Ma fiche" pendant le chargement.
  const [membershipLoaded, setMembershipLoaded] = useState(false);

  const loadMyRole = useCallback(async () => {
    if (!selectedFamily || !user) {
      setMyRole(null);
      setMyLinkedMemberId(null);
      setIsPrimaryAdmin(false);
      setMembershipLoaded(false);
      return;
    }
    try {
      const res = await fetch(`/api/family-memberships?familyId=${selectedFamily.id}`);
      const rows = await res.json();
      const mine = Array.isArray(rows) ? rows.find((r) => r.userId === user.id) : null;
      setMyRole(mine?.role ?? null);
      setMyLinkedMemberId(mine?.linkedMemberId ?? null);
      setIsPrimaryAdmin(!!mine?.isPrimaryAdmin);
      setMembershipLoaded(!!mine);
    } catch {
      setMyRole(null);
      setMyLinkedMemberId(null);
      setIsPrimaryAdmin(false);
      setMembershipLoaded(false);
    }
  }, [selectedFamily, user]);

  // Toutes les fiches de la famille, chacune avec le niveau d'accès de
  // l'utilisateur courant ("full" | "read" | "relay" | null) calculé par le
  // serveur. Les champs médicaux sont absents des fiches non lisibles.
  const [members, setMembers] = useState([]);
  const [membersLoading, setMembersLoading] = useState(false);

  const reloadMembers = useCallback(async () => {
    if (!selectedFamily) {
      setMembers([]);
      return [];
    }
    setMembersLoading(true);
    try {
      const res = await fetch(`/api/members?familyId=${selectedFamily.id}`);
      const data = await res.json();
      const list = Array.isArray(data) ? data : [];
      setMembers(list);
      return list;
    } catch {
      setMembers([]);
      return [];
    } finally {
      setMembersLoading(false);
    }
  }, [selectedFamily]);

  useEffect(() => {
    loadFamilies();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    loadMyRole();
  }, [loadMyRole]);

  useEffect(() => {
    reloadMembers();
  }, [reloadMembers]);

  const isParent = myRole === "parent";
  const isAdult = myRole === "adult";
  const isDependent = myRole === "dependent";

  // Accès par fiche (dossier) — reflet des règles appliquées par le serveur.
  const accessById = useMemo(() => Object.fromEntries(members.map((m) => [m.id, m.access ?? null])), [members]);
  const accessFor = useCallback((memberId) => accessById[Number(memberId)] ?? null, [accessById]);
  const canWriteMember = useCallback((memberId) => accessFor(memberId) === "full", [accessFor]);
  const canReadMember = useCallback(
    (memberId) => {
      const a = accessFor(memberId);
      return a === "full" || a === "read";
    },
    [accessFor]
  );
  const writableMembers = useMemo(() => members.filter((m) => m.access === "full"), [members]);
  const myMember = useMemo(() => members.find((m) => m.isMine) ?? null, [members]);

  // Peut saisir des données médicales sur au moins une fiche — sert à
  // afficher les boutons "Ajouter" ; le contrôle fin se fait fiche par fiche.
  const canWrite = writableMembers.length > 0;

  // L'utilisateur appartient à la famille sélectionnée mais n'a pas encore
  // de fiche à lui (dont il est titulaire) : il doit la désigner ou la créer.
  const needsMyFiche = !!selectedFamily && membershipLoaded && !isDependent && !myLinkedMemberId;

  return (
    <FamilyContext.Provider
      value={{
        families,
        selectedFamily,
        setSelectedFamily,
        loadFamilies,
        loading,
        myRole,
        myLinkedMemberId,
        reloadMembership: loadMyRole,
        isParent,
        isPrimaryAdmin,
        isAdult,
        isDependent,
        canWrite,
        members,
        membersLoading,
        reloadMembers,
        myMember,
        accessFor,
        canWriteMember,
        canReadMember,
        writableMembers,
        needsMyFiche,
        membershipLoaded,
      }}
    >
      {children}
    </FamilyContext.Provider>
  );
}

export function useFamily() {
  const ctx = useContext(FamilyContext);
  if (!ctx) throw new Error("useFamily must be used inside FamilyProvider");
  return ctx;
}
