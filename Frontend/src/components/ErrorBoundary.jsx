import { Component } from "react";
import { AlertTriangle, RotateCw } from "lucide-react";

// Filet de sécurité global : une erreur de rendu dans une page affiche un
// message compréhensible au lieu d'une page blanche.
export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error("Erreur d'affichage :", error, info?.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <div role="alert" className="w-full max-w-sm bg-white rounded-2xl shadow-xl p-8 text-center">
          <AlertTriangle className="text-amber-500 mx-auto mb-4" size={36} />
          <h1 className="text-lg font-bold text-gray-800 mb-1">Une erreur est survenue</h1>
          <p className="text-sm text-gray-500 mb-6">
            Cette page n'a pas pu s'afficher correctement. Rechargez la page ; si le problème persiste, vérifiez
            votre connexion Internet ou réessayez plus tard.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="inline-flex items-center justify-center gap-2 font-semibold rounded-xl text-sm px-4 py-2.5 bg-teal-600 hover:bg-teal-700 text-white shadow-sm focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-teal-500"
          >
            <RotateCw size={16} />
            Recharger la page
          </button>
        </div>
      </div>
    );
  }
}
