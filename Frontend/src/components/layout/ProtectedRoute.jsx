import { Navigate } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { Loader2 } from "lucide-react";

export function ProtectedRoute({ children }) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <Loader2 className="animate-spin text-teal-600" size={40} />
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  // Le compte existe et la session est valide, mais l'adresse courriel n'a
  // pas encore été vérifiée : aucun accès à l'application tant que ce n'est
  // pas fait (règle transverse §10, sans exception).
  if (!user.emailVerified) {
    return <Navigate to="/verification-en-attente" replace />;
  }

  return children;
}