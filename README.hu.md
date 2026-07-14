# 🦷 DQ Dental CAD

**Önállóan futó fogászati CAD webalkalmazás intraorális szkennek (STL/PLY) megjelenítésére, valamint koronák, inlay/onlay betétek és hidak tervezésére.**

🇬🇧 *English description: [README.md](README.md)*

A DQ ökoszisztéma része; önállóan fut, és úgy készül, hogy később modulként integrálható legyen a React-Odontogram-Modul és a React-Dental-CBCT-Viewer mellé.

> **Vezérelv: pontosság a sebesség előtt.** Minden geometriai eredménynek klinikailag megbízhatónak kell lennie. Egy hosszú számítás folyamatjelzővel elfogadható; egy csendben hibás preparációs határvonal nem.

## Funkciók

- **Import / export** — STL (bináris + ASCII) és PLY (bináris LE/BE + ASCII), mesh-előfeldolgozó pipeline-nal (csúcspont-összevonás, degenerált háromszögek eltávolítása, orientáció-javítás, statisztikák) és kötelező mértékegység-megerősítéssel (az STL nem hordoz mértékegységet)
- **Teljes 3D nézegető** — forgatás/mozgatás/nagyítás, szabványos nézetek, árnyalási módok, drótváz, kijelölés, jelenetfa
- **Elemzőeszközök** — pont-pont mérések (BVH-gyorsítással), felület-felület távolság-hőtérképek, keresztmetszetek kitöltött záró felületekkel és SVG-exporttal
- **Mesh-javítás** — komponensek eltávolítása, non-manifold élek szétválasztása, kis lyukak tömése — mindig kifejezett felhasználói megerősítéssel, soha nem csendben
- **Geometriai kernel** — halfedge topológia, diszkrét görbület (átlag-, Gauss-, főgörbületek), geodetikus utak, a mesh felületére illesztett köbös spline-ok (preparációs határvonal szerkesztése)
- **Restaurátum-tervezés** *(folyamatban)* — preparációs határvonal, behelyezési tengely + alámenős területek elemzése, korona/inlay/onlay/híd tervezés verziózott klinikai anyagprofilok alapján
- **Gyártási export** — vízzáró bináris STL géppel olvasható QC-riporttal; a szerver minden exportot függetlenül újravalidál
- **Esetmentés** — teljes tervezésilépés-napló (visszavonás/újra, bármely lépésnél újranyitható), tartalomcímzett, megváltoztathatatlan szkentárolás

## Architektúra

```
React UI héj (panelek, i18n, téma)
        │  zustand snapshotok
Engine (imperatív TS — SceneManager / ToolManager / CaseStore, Three.js, Float32 render-másolatok)
        │  Comlink RPC, transferable bufferek
Geometriai workerek (Web Worker pool)
   ├─ kernel  — tiszta TypeScript, Float64: halfedge, görbület, geodetikus utak, spline-ok, BVH
   ├─ manifold-3d (WASM) — boole-műveletek, javítás, garantáltan manifold kimenetek
   └─ io      — STL/PLY beolvasás és kiírás
        │  REST + WebSocket
Node.js backend (Fastify + Prisma + SQLite) — esetek, fájlok, fogkönyvtár,
független export-újravalidálás ugyanazzal a kernellel
```

### A repó felépítése

| Útvonal | Tartalom |
|---|---|
| `apps/client/` | React UI + imperatív engine (Three.js csak itt él) |
| `apps/server/` | Fastify + Prisma + SQLite; export-újravalidálás |
| `packages/kernel/` | Float64 geometriai mag — tiszta TS, se DOM, se Three.js |
| `packages/kernel-workers/` | Worker belépési pontok (Comlink), böngésző és Node |
| `packages/io/` | STL/PLY parserek/kiírók — tiszta TS |
| `packages/cad-pipeline/` | Restaurátum-tervezési lépések + QC-kapuk |
| `packages/clinical-profiles/` | Verziózott anyagprofilok (JSON, sémaellenőrzött) |
| `packages/shared-types/` | CaseDocument, Operation, QcReport |

## Első lépések

### Előfeltételek

- Node.js **>= 23.6** (lásd `engines.node` a `package.json`-ban)
- [Git LFS](https://git-lfs.com/) — a `test-fixtures/**/*.stl` és `*.ply` fájlok LFS-ben tárolódnak; futtasd egyszer a `git lfs install`-t, majd klónozz normálisan (vagy `git lfs pull`, ha az LFS telepítése előtt klónoztál)

### Telepítés

```bash
git clone https://github.com/ZoliQua/React-Dental-Designer.git
cd React-Dental-Designer
npm install
npm run dev
```

Az `npm install` lefuttatja az `apps/server` `postinstall` lépését (`prisma generate`). A szerver SQLite fejlesztői adatbázisa az első indításkor automatikusan létrejön: az `npm run dev` létrehozza az `apps/server/.env` fájlt az `.env.example`-ből, ha hiányzik, és lefuttatja a `prisma migrate deploy`-t az API indulása előtt — friss klónon nincs szükség kézi migrációra.

### Parancsok

```bash
npm run dev               # kliens + szerver + workerek (Vite az 5173-on, API a 4100-on)
npm run build             # produkciós build (minden workspace)
npm test                  # teljes Vitest teszthalmaz (kernel, io, pipeline, szerver)
npm run test:kernel       # csak kernel — a leggyorsabb kör geometriai munkához
npm run test:golden       # golden-fájl regressziós tesztek (test-fixtures Git LFS-ből)
npm run test:e2e          # Playwright tervezési-folyamat tesztek (chromium)
npm run lint && npm run typecheck
```

A fixture-ök a `test-fixtures/` mappában élnek (Git LFS). Ha a golden tesztek „Git LFS pointer file" hibával buknak, futtasd a `git lfs pull`-t. Az `npm run test:e2e` saját `npm run dev` példányt indít, hacsak nem fut már egy a `http://localhost:5173` címen.

## Mérnöki alapelvek

- **Float64 mindenhol a kernelben.** Float32 csak a render-másolatokban létezik. A preparált csonkok ~10 mm-es objektumok 50 µm-es részletekkel; a láncolt Float32-műveletek látható hibát halmoznak fel.
- **Determinizmus.** Azonos bemenetek + paraméterek + kernelverzió ⇒ bitre azonos kimenetek. Nincs seed nélküli véletlenszerűség, nincs óraidő a számításokban.
- **Naplózott műveletek.** Minden destruktív művelet rögzítésre kerül (név, paraméterek, bemeneti/kimeneti hash-ek); a napló visszajátszása azonos hash-eket ad — CI ellenőrzi.
- **A QC-kapuk blokkolják az exportot.** Vízzáróság, manifoldság, önátmetszések, minimális falvastagság, összekötő-keresztmetszet, széli záródás eltérése, beültetési penetráció. A kapuk naplózott figyelmeztetéssel tudomásul vehetők — csendben soha nem kerülhetők meg.
- **Kettős validálás.** A szerver a Node-kernellel újrafuttatja az összes QC-kaput pontosan az exportált bájtokon, mielőtt bármilyen fájlt kiadna.
- **Dokumentált hibakorlátok.** Minden közelítő algoritmus (SDF-offszetek, marching cubes) dokumentálja a hibakorlátját, és megjeleníti a QC-riportban.

Lásd a [`PLAN.md`](./PLAN.md)-t a fázisokhoz, átvételi kritériumokhoz és a klinikai adatmodellhez, valamint a [`CLAUDE.md`](./CLAUDE.md)-t a teljes mérnöki invariánsokhoz.

## Ütemterv

| Fázis | Tartalom | Állapot |
|---|---|---|
| 0 | Alapozás: monorepo, nézegető héj, szerver, worker pool, manifold WASM, CI | ✅ kész |
| 1 | Import és nézegető (M1 „Megbízható nézegető") | ✅ kész |
| 2 | Geometriai kernel mag: hash-elés, halfedge, görbület, geodetikus utak, spline-ok, offszetek | 🔨 folyamatban |
| 3 | Eset-előkészítés, preparációs határvonal, behelyezési tengely | ⏳ tervezett |
| 4 | Koronatervezés | ⏳ tervezett |
| 5 | Inlay / onlay | ⏳ tervezett |
| 6 | Híd | ⏳ tervezett |
| 7 | Export és gyártási átadás | ⏳ tervezett |
| 8 | Csiszolás és megszilárdítás | ⏳ tervezett |

## Nyelvi támogatás

UI-nyelvek: angol, magyar, német, spanyol. Sötét/világos téma CSS custom property-kkel. A fogszámozás az FDI-sémát követi (11–48).

## Jogi nyilatkozat

Ez a szoftver aktív fejlesztés alatt áll, és nem minősített orvostechnikai eszköz. A kimeneteket klinikai vagy gyártási felhasználás előtt képzett fogászati szakembernek kell ellenőriznie.
