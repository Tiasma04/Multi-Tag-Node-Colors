# Multi-Tag Node Colors

Plugin Obsidian qui colore les nœuds de la vue graphique en camembert quand une note correspond à plusieurs groupes de couleurs de tags.

Exemple : `#windows` en bleu et `#scripting` en jaune. Une note avec les deux tags aura un nœud moitié bleu, moitié jaune. Avec 3 tags, le nœud a 3 parts, et ainsi de suite.

## Installation

1. Créer le dossier `<ton-coffre>/.obsidian/plugins/multi-tag-node-colors/`.
2. Copier `main.js` et `manifest.json` dedans.
3. Dans Obsidian : Paramètres > Plugins communautaires, recharger la liste puis active **Multi-Tag Node Colors**.

## Utilisation

Les couleurs ne se configurent pas dans le plugin. Elles viennent des **groupes du graphe** (panneau de réglages du graphe > Groupes) :

- Créer un groupe par tag avec une requête simple : `tag:#windows`, `tag:#scripting`, etc.
- L'ordre des parts suit l'ordre des groupes, ce qui donne la même disposition sur tous les nœuds.
- Les groupes dont la requête n'est pas un simple tag (`path:`, `file:`, combinaisons `OR`…) sont ignorés par le plugin. Ils continuent de colorer les nœuds normalement.
- Le graphe global et le graphe local ont chacun leurs propres groupes.

Réglages du plugin :

- **Inclure les sous-tags** : `tag:#windows` colore aussi `#windows/server`. Activé par défaut, comme la recherche d'Obsidian.
- **Séparateur entre les parts** : trait de la couleur du fond entre les parts.
- **Angle de départ** : position de la première part.

Commande : « Rafraîchir les nœuds multi-tags », à utiliser si un nœud n'est pas à jour.

## Limites

- Le graphe d'Obsidian n'a pas d'API publique. Le plugin s'appuie sur des objets internes, qu'une mise à jour d'Obsidian peut casser.
- Le camembert recouvre le disque d'origine. La surbrillance du nœud survolé (changement de couleur) n'est donc plus visible sur les nœuds multi-tags. L'atténuation des autres nœuds reste visible.
- Les nœuds avec un seul tag coloré sont laissés à Obsidian.
- Non testé avec Extended Graph activé en même temps.
