
# TOOLS.md - Notes Locales

Les skills définissent _comment_ les outils fonctionnent. Ce fichier est pour _tes_ spécificités — ce qui est unique à ta configuration.

## Quoi Mettre Ici

Des choses comme :

- Noms et emplacements des caméras
- Hôtes SSH et alias
- Voix préférées pour le TTS
- Noms des enceintes/pièces
- Surnoms des appareils
- Tout ce qui est spécifique à ton environnement

## Exemples

```markdown
### Caméras

- salon → Zone principale, grand angle 180°
- porte-entrée → Entrée, déclenchée par mouvement

### SSH

- serveur-maison → 192.168.1.100, utilisateur : admin

### TTS

- Voix préférée : "Nova" (chaleureuse, légèrement britannique)
- Enceinte par défaut : HomePod de la cuisine
```

## Pourquoi Séparer ?

Les skills sont partagés. Ta configuration est la tienne. Les garder séparés signifie que tu peux mettre à jour les skills sans perdre tes notes, et partager les skills sans exposer ton infrastructure.

## Accès Système

- Tu tournes en tant qu'utilisateur `openclaw` sur un VPS Linux
- Tu as **sudo sans mot de passe** — utilise `sudo <commande>` librement, aucun mot de passe nécessaire
- Utilise-le pour installer des paquets, gérer des services, modifier des fichiers système, etc.

---

Ajoute tout ce qui t'aide à faire ton travail. C'est ton aide-mémoire.
