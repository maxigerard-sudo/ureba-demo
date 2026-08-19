/*
 * Hors ligne PAR DEFAUT, et non « hors ligne quand le reseau tombe ».
 *
 * Le relevé se fait en chaufferie, souvent sans réseau du tout. Les FICHIERS de
 * la coquille sont donc servis depuis le cache d'abord — leur nom porte une
 * empreinte, leur contenu ne change jamais sous le même nom. La PAGE, elle, se
 * demande au réseau d'abord et retombe sur le cache : c'est elle qui dit quelle
 * version on exécute, et une version périmée qui répond normalement est le pire
 * des deux mondes. Voir `servirPage` plus bas.
 *
 * Aucune donnée d'audit ne passe ici : elle vit dans IndexedDB, et rien ne sort
 * de l'appareil.
 *
 * ## La page seule ne suffit pas — éprouvé le 14/08/2026
 *
 * Mettre `index.html` en cache ne met pas en cache ce qu'elle CHARGE. Les noms
 * des fichiers portent une empreinte qui change à chaque construction :
 * `index-nKNY4_np.js` aujourd'hui, un autre nom demain. Une page fraîche
 * associée à des fichiers qui ne sont pas encore en cache donne, hors ligne,
 * un écran blanc et cette erreur-ci :
 *
 *     Expected a JavaScript-or-Wasm module script but the server responded
 *     with a MIME type of "text/html"
 *
 * — parce que la requête du script tombe dans le vide et récupère la page.
 * C'est arrivé au premier essai hors ligne, et ça se serait produit sur la
 * tablette d'un auditeur, dans une chaufferie, sans réseau pour s'en sortir.
 *
 * D'où `chauffer()` : chaque fois qu'on obtient une page, on lit les fichiers
 * qu'elle référence et on les met en cache AVEC elle. La coquille est alors
 * complète ou absente, jamais à moitié.
 *
 * ## Et `ignoreVary` — sans quoi le cache refuse ce qu'il contient
 *
 * Second défaut du même essai, plus retors : les fichiers ÉTAIENT en cache, et
 * le navigateur recevait quand même `net::ERR_FAILED`. La réponse enregistrée
 * portait `Vary: Origin`. Or un `<script type="module">` part en mode CORS et
 * envoie un en-tête `Origin`, même vers sa propre origine — alors que la copie
 * mise en cache par le service worker n'en avait pas. Deux requêtes pour la
 * même URL, jugées différentes par `Vary`, et le cache répond « je n'ai pas ».
 *
 * On sert une coquille statique : les octets sont les mêmes quel que soit
 * l'appelant. `ignoreVary: true` dit exactement cela, et c'est ce qui fait
 * tenir le hors ligne.
 */
const CACHE = "ureba-coquille-v1";
const COQUILLE = ["./", "./index.html", "./manifest.webmanifest", "./icone.svg"];

/**
 * Met en cache les fichiers qu'une page référence.
 *
 * On lit le HTML plutôt que d'inscrire des noms ici : ils changent à chaque
 * construction, et une liste écrite à la main serait fausse dès la suivante.
 */
async function chauffer(reponse) {
  try {
    const html = await reponse.clone().text();
    const liens = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
      .map((m) => m[1])
      .filter((u) => /\.(?:js|css|svg|webmanifest)$/.test(u))
      .map((u) => new URL(u, reponse.url || self.location.href).href)
      .filter((u) => new URL(u).origin === self.location.origin);
    if (liens.length === 0) return;
    const cache = await caches.open(CACHE);
    await Promise.all(
      liens.map(async (lien) => {
        // Déjà là : on n'y retouche pas. Le nom porte l'empreinte, donc le
        // contenu ne change pas sous le même nom.
        if (await cache.match(lien, { ignoreVary: true })) return;
        const r = await fetch(lien, { cache: "reload" });
        if (r && r.status === 200) await cache.put(lien, r.clone());
      }),
    );
  } catch {
    // Une coquille incomplète vaut mieux qu'une installation qui échoue : la
    // page reste servie, et la prochaine visite en ligne réessaiera.
  }
}

self.addEventListener("install", (e) => {
  e.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache.addAll(COQUILLE);
      const page = await cache.match("./index.html");
      if (page) await chauffer(page);
    })(),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((cles) =>
      Promise.all(cles.filter((c) => c !== CACHE).map((c) => caches.delete(c))),
    ),
  );
  self.clients.claim();
});

/**
 * Au-delà, on sert ce qu'on a. Un réseau absent échoue en général tout de
 * suite ; c'est le réseau qui RÉPOND MAL — portail captif, une barre en
 * chaufferie — qui fait attendre, et il ne doit pas retenir la page.
 */
const DELAI_RESEAU = 2500;

function avecDelai(promesse, millisecondes) {
  return Promise.race([
    promesse,
    new Promise((_, rejeter) => setTimeout(() => rejeter(new Error("délai")), millisecondes)),
  ]);
}

/**
 * La PAGE se demande au réseau d'abord, et retombe sur le cache.
 *
 * ## Pourquoi pas le cache d'abord, comme le reste
 *
 * Parce que la page est la seule chose qui dit quelle VERSION on exécute. Servie
 * depuis le cache, elle donne l'interface d'avant — qui répond, qui a l'air
 * normale, et qui n'est pas celle qu'on vient de publier. Le réseau la
 * rafraîchissait bien en arrière-plan, mais pour la visite SUIVANTE : le premier
 * chargement après chaque publication était périmé.
 *
 * Ça s'est payé le 15/08/2026 : deux essais menés sur du code d'avant, en
 * croyant que rien n'avait changé. C'est le même défaut que celui du 14/08 sur
 * le serveur de développement, à un endroit de plus — et il est pire ici, parce
 * qu'il survit à un rechargement.
 *
 * ## Ce que ça ne coûte pas
 *
 * Le hors ligne. Sans réseau, `fetch` échoue tout de suite et le cache répond ;
 * avec un réseau qui traîne, `DELAI_RESEAU` tranche. La requête abandonnée
 * continue et **met quand même le cache à jour** quand elle arrive : rien n'est
 * perdu, c'est seulement trop tard pour cette visite-ci.
 *
 * Les fichiers, eux, gardent le cache d'abord : leur nom porte une empreinte,
 * donc leur contenu ne change jamais sous le même nom. Il n'y a rien à
 * rafraîchir, et tout à gagner à les servir sans attendre.
 */
async function servirPage(requete) {
  const reseau = fetch(requete).then((reponse) => {
    if (reponse && reponse.status === 200) {
      const copie = reponse.clone();
      caches.open(CACHE).then((c) => c.put(requete, copie));
      // Une page fraîche entraîne ses fichiers avec elle. Sans ça, la prochaine
      // visite hors ligne servirait une page neuve avec des fichiers absents —
      // un écran blanc.
      chauffer(reponse.clone());
    }
    return reponse;
  });

  try {
    const reponse = await avecDelai(reseau, DELAI_RESEAU);
    if (reponse && reponse.status === 200) return reponse;
  } catch {
    // Réseau absent, ou trop lent pour qu'on l'attende. Le cache prend le
    // relais — c'est exactement ce pour quoi il est là.
  }

  const enCache = await caches.match(requete, { ignoreVary: true });
  if (enCache) return enCache;
  // Hors ligne, une requête de page qui ne trouve rien retombe sur la coquille :
  // c'est elle qui sait démarrer l'interface.
  const coquille = await caches.match("./index.html", { ignoreVary: true });
  return coquille || reseau;
}

/** Un fichier : le cache d'abord, le réseau pour le compléter et le rafraîchir. */
async function servirFichier(requete) {
  const enCache = await caches.match(requete, { ignoreVary: true });
  const reseau = fetch(requete)
    .then((reponse) => {
      if (reponse && reponse.status === 200) {
        const copie = reponse.clone();
        caches.open(CACHE).then((c) => c.put(requete, copie));
      }
      return reponse;
    })
    .catch(() => enCache);
  return enCache || reseau;
}

self.addEventListener("fetch", (e) => {
  const requete = e.request;
  if (requete.method !== "GET" || new URL(requete.url).origin !== self.location.origin) return;
  e.respondWith(requete.mode === "navigate" ? servirPage(requete) : servirFichier(requete));
});
