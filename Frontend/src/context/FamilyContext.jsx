import { createContext, useContext, useState, useEffect, useCallback } from "react";
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

  const loadMyRole = useCallback(async () => {
    if (!selectedFamily || !user) {
      setMyRole(null);
      setMyLinkedMemberId(null);
      return;
    }
    try {
      const res = await fetch(`/api/family-memberships?familyId=${selectedFamily.id}`);
      const rows = await res.json();
      const mine = rows.find((r) => r.userId === user.id);
      setMyRole(mine?.role ?? null);
      setMyLinkedMemberId(mine?.linkedMemberId ?? null);
    } catch {
      setMyRole(null);
      setMyLinkedMemberId(null);
    }
  }, [selectedFamily, user]);

  useEffect(() => {
    loadFamilies();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    loadMyRole();
  }, [loadMyRole]);

  const isParent = myRole === "parent";
  const isAdult = myRole === "adult";
  const isDependent = myRole === "dependent";
  // Peut créer/modifier des données médicales (Parent et Adulte, pas Dépendant)
  const canWrite = isParent || isAdult;

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
        isParent,
        isAdult,
        isDependent,
        canWrite,
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