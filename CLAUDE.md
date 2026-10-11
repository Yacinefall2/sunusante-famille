# SunuSanté Famille — notes pour Claude

## À faire en priorité au début de la prochaine session

**Pousser la recherche des traitements par membre ou par maladie.**

- Commit `Traitements : recherche par membre ou par maladie` (fichier
  `Frontend/src/pages/Traitements.jsx`), fait le 11 octobre 2026 sur la branche
  `claude/stoic-davinci-zsqge4`, à partir de `main` au commit `2114459`.
- Le push avait échoué (erreur 403 : pas d'accès en écriture au dépôt
  `Yacinefall2/sunusante-famille`, l'ordinateur de l'utilisatrice étant éteint).
- L'utilisatrice demande que Claude le pousse lui-même dès que l'accès est
  rétabli :
  1. Vérifier que la branche `claude/stoic-davinci-zsqge4` contient ce commit.
     S'il manque (conteneur effacé), demander le fichier
     `traitements-recherche.patch` envoyé dans la conversation et l'appliquer
     avec `git am` sur une branche partie de `main`.
  2. `git push -u origin claude/stoic-davinci-zsqge4`.
  3. Une fois poussé, retirer cette section du fichier.
- Ne pas ouvrir de pull request sans qu'on le demande.
