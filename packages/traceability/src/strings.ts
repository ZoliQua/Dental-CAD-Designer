// packages/traceability/src/strings.ts
//
// The renderer's bundled i18n tables (EN/HU/DE/ES). These strings live HERE
// — not in apps/client/src/i18n/ — because the render function is shared by
// the SERVER (release documents on GET .../traceability.html) and the client
// (preview), and the server has no access to the client's i18n bundle; one
// table here is the single source both sides render from (the CLAUDE.md
// "no hardcoded UI strings" rule is honored by keying every string, with
// the key tables package-local for the same reason the render function is).
// Locale is always an EXPLICIT parameter — nothing here reads environment
// locale state (render purity).
//
// Hungarian uses the established clinical terminology of the client UI
// (vízzáró, határvonal-illeszkedés, csücsökfedés, hídtag, összekötő,
// "tudomásul véve" — see apps/client/src/i18n/hu.json) — the lab hands this
// document to a human.
//
// Unit symbols (mm, µm, mm², mm³) are NOT translated — metric symbols are
// identical across all four locales (the formatMm.ts precedent).

export const TRACEABILITY_LOCALES = ['en', 'hu', 'de', 'es'] as const;
export type TraceabilityLocale = (typeof TRACEABILITY_LOCALES)[number];

const en = {
  title: 'QC Traceability Document',
  previewWatermark: 'PREVIEW — NOT A RELEASE DOCUMENT',
  kindRelease: 'Release record',
  kindPreview: 'Pre-export preview (client QC report — nothing has been released)',
  schemaVersionLabel: 'Document schema version',

  identityHeading: 'Restoration identity',
  caseLabel: 'Case',
  restorationLabel: 'Restoration',
  typeLabel: 'Type',
  teethLabel: 'Teeth (FDI)',
  'type.crown': 'Crown',
  'type.inlay': 'Inlay',
  'type.onlay': 'Onlay',
  'type.bridge': 'Bridge',

  qcHeading: 'Quality control gates',
  qcPassed: 'All gates passed or were explicitly acknowledged.',
  qcFailed: 'FAILING GATES PRESENT — this state does not authorize an export.',
  gateColumn: 'Gate',
  measuredColumn: 'Measured',
  thresholdColumn: 'Threshold',
  statusColumn: 'Status',
  messageColumn: 'Details',
  'gateStatus.pass': 'pass',
  'gateStatus.fail': 'FAIL',
  'gateStatus.acknowledged': 'FAIL — acknowledged',
  'gate.watertight': 'Watertight',
  'gate.manifold': 'Manifold edges',
  'gate.selfIntersection': 'Self-intersection',
  'gate.minWallThickness': 'Minimum wall thickness',
  'gate.marginFit': 'Margin fit',
  'gate.seating': 'Seating',
  'gate.connectorCrossSection': 'Connector cross-section',
  'gate.contact': 'Occlusal/proximal contacts',
  'gate.seamDihedral': 'Seam dihedral angle',
  'gate.cuspCoverageThickness': 'Cusp coverage thickness',
  'gate.ponticRelief': 'Pontic relief',

  ackHeading: 'Acknowledged warnings',
  ackNotice:
    'The following failing gates were EXPLICITLY acknowledged by the operator (journaled — never silently bypassed). The signer must review each one.',
  ackOperationLabel: 'Journal operation',
  ackUnjournaledLabel: 'no journal reference',

  profileHeading: 'Material profile',
  profileIdLabel: 'Profile',
  profileVersionLabel: 'Version',
  profileChecksumLabel: 'Checksum (canonical JSON, SHA-256)',

  versionsHeading: 'Software versions',
  kernelVersionLabel: 'Geometry kernel',
  manifoldVersionLabel: 'manifold-3d (boolean engine)',

  fileHeading: 'Released file',
  formatLabel: 'Format',
  bytesHashLabel: 'File bytes SHA-256',
  byteLengthLabel: 'File size (bytes)',
  meshContentHashLabel: 'Design mesh content hash (Float64)',
  headerTextLabel: 'STL header text (journaled)',

  journalHeading: 'Journal binding',
  journalHashLabel: 'Case journal hash',
  journalOpCountLabel: 'Journal operations',
  exportOperationLabel: 'Export operation',

  reimportHeading: 'Independent server re-validation',
  reimportHashLabel: 'Re-imported mesh content hash',
  'relation.stl-canonical-reindex-f32-narrowing':
    'STL re-import: canonical vertex re-index + float32 narrowing of the design mesh — the two content hashes legitimately differ; every gate result was measured on the re-imported bytes.',
  'relation.ply-lossless-identity':
    'PLY re-import: lossless Float64 round trip — the re-imported mesh is content-identical to the design mesh.',
  gateIdentityLine:
    'The server re-computed every gate on the re-imported export bytes; the results are exactly identical to the client report (dual validation).',

  boundsHeading: 'Format error bounds',
  boundsStlLine:
    'Binary STL stores float32 coordinates. Worst-case narrowing error for this file: {bound} mm (analytic half-ULP bound at the largest coordinate magnitude {maxCoord}).',
  boundsGateNote:
    'Algorithmic approximation bounds of individual QC measurements are carried verbatim in the gate results above.',

  certHeading: 'Certification scope',
  'limitation.outer-envelope-not-certified':
    'NOT CERTIFIED: the delivered solid’s outer envelope. The release certifies the QC gate results measured on the re-imported export bytes and their agreement with the client report; no gate compares the delivered outer shape against the designed source mesh.',
  certRecordText: 'Record text',

  releasedAtLabel: 'Released at (server record field — not part of the hashed document)',
  notAvailable: '—',
} as const;

export type TraceabilityStringKey = keyof typeof en;

const hu: Record<TraceabilityStringKey, string> = {
  title: 'Minőségellenőrzési nyomonkövetési dokumentum',
  previewWatermark: 'ELŐNÉZET — NEM KIADÁSI DOKUMENTUM',
  kindRelease: 'Kiadási jegyzőkönyv',
  kindPreview: 'Kiadás előtti előnézet (kliens QC-jelentés — semmi nem került kiadásra)',
  schemaVersionLabel: 'Dokumentum sémaverzió',

  identityHeading: 'Pótlás azonosítása',
  caseLabel: 'Eset',
  restorationLabel: 'Pótlás',
  typeLabel: 'Típus',
  teethLabel: 'Fogak (FDI)',
  'type.crown': 'Korona',
  'type.inlay': 'Inlay (betét)',
  'type.onlay': 'Onlay (rálapolás)',
  'type.bridge': 'Híd',

  qcHeading: 'Minőségellenőrzési kapuk',
  qcPassed: 'Minden kapu megfelelt, vagy kifejezetten tudomásul lett véve.',
  qcFailed: 'SIKERTELEN KAPUK VANNAK — ez az állapot nem engedélyez exportot.',
  gateColumn: 'Kapu',
  measuredColumn: 'Mért érték',
  thresholdColumn: 'Küszöb',
  statusColumn: 'Állapot',
  messageColumn: 'Részletek',
  'gateStatus.pass': 'megfelelt',
  'gateStatus.fail': 'NEM FELELT MEG',
  'gateStatus.acknowledged': 'NEM FELELT MEG — tudomásul véve',
  // Review N1, documented DELIBERATE choice: the client itself carries two
  // established Hungarian terms for "watertight" — the import-stats panel
  // says 'Vízhatlan' (hu.json import.stats.watertight) while the crown/
  // cavity/bridge DESIGN-workflow panels say 'Vízzáró ✓' (shellWatertightYes/
  // assemblyWatertightYes). The traceability document describes the QC gate
  // the clinician just saw in the design workflow, so it follows the
  // 'vízzáró' root, not the import-stats variant.
  'gate.watertight': 'Vízzáróság',
  'gate.manifold': 'Sokaság (manifold) élek',
  'gate.selfIntersection': 'Önmetszés',
  'gate.minWallThickness': 'Minimális falvastagság',
  'gate.marginFit': 'Határvonal-illeszkedés',
  'gate.seating': 'Felfekvés (beültethetőség)',
  'gate.connectorCrossSection': 'Összekötő keresztmetszet',
  'gate.contact': 'Okkluzális/approximális kontaktok',
  'gate.seamDihedral': 'Varrat kétszög',
  'gate.cuspCoverageThickness': 'Csücsökfedés vastagsága',
  'gate.ponticRelief': 'Hídtag-tehermentesítés',

  ackHeading: 'Tudomásul vett figyelmeztetések',
  ackNotice:
    'Az alábbi sikertelen kapukat a kezelő KIFEJEZETTEN tudomásul vette (naplózva — soha nem csendben megkerülve). Az aláírónak mindet át kell néznie.',
  ackOperationLabel: 'Naplóművelet',
  ackUnjournaledLabel: 'nincs naplóhivatkozás',

  profileHeading: 'Anyagprofil',
  profileIdLabel: 'Profil',
  profileVersionLabel: 'Verzió',
  profileChecksumLabel: 'Ellenőrző összeg (kanonikus JSON, SHA-256)',

  versionsHeading: 'Szoftververziók',
  kernelVersionLabel: 'Geometriai kernel',
  manifoldVersionLabel: 'manifold-3d (boole-motor)',

  fileHeading: 'Kiadott fájl',
  formatLabel: 'Formátum',
  bytesHashLabel: 'Fájl bájtok SHA-256',
  byteLengthLabel: 'Fájlméret (bájt)',
  meshContentHashLabel: 'Tervezett háló tartalom-hash (Float64)',
  headerTextLabel: 'STL fejlécszöveg (naplózott)',

  journalHeading: 'Naplókötés',
  journalHashLabel: 'Eset-napló hash',
  journalOpCountLabel: 'Naplóműveletek száma',
  exportOperationLabel: 'Exportművelet',

  reimportHeading: 'Független szerveroldali újravalidálás',
  reimportHashLabel: 'Újraimportált háló tartalom-hash',
  'relation.stl-canonical-reindex-f32-narrowing':
    'STL újraimport: kanonikus csúcs-újraindexelés + float32 szűkítés a tervezett hálóhoz képest — a két tartalom-hash jogosan tér el; minden kapueredmény az újraimportált bájtokon lett mérve.',
  'relation.ply-lossless-identity':
    'PLY újraimport: veszteségmentes Float64 körbejárás — az újraimportált háló tartalmilag azonos a tervezett hálóval.',
  gateIdentityLine:
    'A szerver minden kaput újraszámolt az újraimportált export-bájtokon; az eredmények pontosan megegyeznek a kliens jelentésével (kettős validálás).',

  boundsHeading: 'Formátum-hibakorlátok',
  boundsStlLine:
    'A bináris STL float32 koordinátákat tárol. E fájl legrosszabb esetű szűkítési hibája: {bound} mm (analitikus fél-ULP korlát a legnagyobb koordináta-nagyságnál: {maxCoord}).',
  boundsGateNote:
    'Az egyes QC-mérések algoritmikus közelítési korlátait a fenti kapueredmények változatlanul hordozzák.',

  certHeading: 'Tanúsítási hatókör',
  'limitation.outer-envelope-not-certified':
    'NEM TANÚSÍTOTT: a kiadott test külső burkolata. A kiadás az újraimportált export-bájtokon mért QC-kapueredményeket és azok kliens-jelentéssel való egyezését tanúsítja; egyetlen kapu sem veti össze a kiadott külső formát a tervezett forráshálóval.',
  certRecordText: 'Jegyzőkönyvi szöveg',

  releasedAtLabel:
    'Kiadás ideje (szerveroldali nyilvántartási mező — nem része a hash-elt dokumentumnak)',
  notAvailable: '—',
};

const de: Record<TraceabilityStringKey, string> = {
  title: 'QK-Rückverfolgbarkeitsdokument',
  previewWatermark: 'VORSCHAU — KEIN FREIGABEDOKUMENT',
  kindRelease: 'Freigabeprotokoll',
  kindPreview: 'Vorschau vor dem Export (Client-QK-Bericht — nichts wurde freigegeben)',
  schemaVersionLabel: 'Dokument-Schemaversion',

  identityHeading: 'Identität der Restauration',
  caseLabel: 'Fall',
  restorationLabel: 'Restauration',
  typeLabel: 'Typ',
  teethLabel: 'Zähne (FDI)',
  'type.crown': 'Krone',
  'type.inlay': 'Inlay',
  'type.onlay': 'Onlay',
  'type.bridge': 'Brücke',

  qcHeading: 'Qualitätskontroll-Gates',
  qcPassed: 'Alle Gates bestanden oder ausdrücklich zur Kenntnis genommen.',
  qcFailed: 'NICHT BESTANDENE GATES VORHANDEN — dieser Zustand autorisiert keinen Export.',
  gateColumn: 'Gate',
  measuredColumn: 'Messwert',
  thresholdColumn: 'Grenzwert',
  statusColumn: 'Status',
  messageColumn: 'Details',
  'gateStatus.pass': 'bestanden',
  'gateStatus.fail': 'NICHT BESTANDEN',
  'gateStatus.acknowledged': 'NICHT BESTANDEN — zur Kenntnis genommen',
  'gate.watertight': 'Wasserdichtigkeit',
  'gate.manifold': 'Mannigfaltigkeitskanten',
  'gate.selfIntersection': 'Selbstdurchdringung',
  'gate.minWallThickness': 'Mindestwandstärke',
  'gate.marginFit': 'Randpassung',
  'gate.seating': 'Sitz (Aufpassung)',
  'gate.connectorCrossSection': 'Verbinderquerschnitt',
  'gate.contact': 'Okklusale/approximale Kontakte',
  'gate.seamDihedral': 'Naht-Diederwinkel',
  'gate.cuspCoverageThickness': 'Höckerüberdeckungsstärke',
  'gate.ponticRelief': 'Brückenglied-Entlastung',

  ackHeading: 'Zur Kenntnis genommene Warnungen',
  ackNotice:
    'Die folgenden nicht bestandenen Gates wurden vom Bediener AUSDRÜCKLICH zur Kenntnis genommen (journalisiert — niemals stillschweigend umgangen). Der Unterzeichner muss jedes einzelne prüfen.',
  ackOperationLabel: 'Journal-Operation',
  ackUnjournaledLabel: 'keine Journal-Referenz',

  profileHeading: 'Materialprofil',
  profileIdLabel: 'Profil',
  profileVersionLabel: 'Version',
  profileChecksumLabel: 'Prüfsumme (kanonisches JSON, SHA-256)',

  versionsHeading: 'Softwareversionen',
  kernelVersionLabel: 'Geometriekernel',
  manifoldVersionLabel: 'manifold-3d (Boolesche Engine)',

  fileHeading: 'Freigegebene Datei',
  formatLabel: 'Format',
  bytesHashLabel: 'Datei-Bytes SHA-256',
  byteLengthLabel: 'Dateigröße (Bytes)',
  meshContentHashLabel: 'Inhalts-Hash des Designnetzes (Float64)',
  headerTextLabel: 'STL-Kopfzeilentext (journalisiert)',

  journalHeading: 'Journalbindung',
  journalHashLabel: 'Fall-Journal-Hash',
  journalOpCountLabel: 'Journal-Operationen',
  exportOperationLabel: 'Export-Operation',

  reimportHeading: 'Unabhängige Server-Revalidierung',
  reimportHashLabel: 'Inhalts-Hash des reimportierten Netzes',
  'relation.stl-canonical-reindex-f32-narrowing':
    'STL-Reimport: kanonische Vertex-Neuindizierung + Float32-Verengung gegenüber dem Designnetz — die beiden Inhalts-Hashes weichen legitim voneinander ab; jedes Gate-Ergebnis wurde auf den reimportierten Bytes gemessen.',
  'relation.ply-lossless-identity':
    'PLY-Reimport: verlustfreier Float64-Umlauf — das reimportierte Netz ist inhaltsidentisch mit dem Designnetz.',
  gateIdentityLine:
    'Der Server hat jedes Gate auf den reimportierten Export-Bytes neu berechnet; die Ergebnisse sind exakt identisch mit dem Client-Bericht (duale Validierung).',

  boundsHeading: 'Format-Fehlerschranken',
  boundsStlLine:
    'Binäres STL speichert Float32-Koordinaten. Maximaler Verengungsfehler dieser Datei: {bound} mm (analytische Halb-ULP-Schranke bei der größten Koordinatenmagnitude {maxCoord}).',
  boundsGateNote:
    'Algorithmische Näherungsschranken einzelner QK-Messungen werden unverändert in den obigen Gate-Ergebnissen mitgeführt.',

  certHeading: 'Zertifizierungsumfang',
  'limitation.outer-envelope-not-certified':
    'NICHT ZERTIFIZIERT: die Außenhülle des gelieferten Körpers. Die Freigabe zertifiziert die auf den reimportierten Export-Bytes gemessenen QK-Gate-Ergebnisse und deren Übereinstimmung mit dem Client-Bericht; kein Gate vergleicht die gelieferte Außenform mit dem entworfenen Quellnetz.',
  certRecordText: 'Protokolltext',

  releasedAtLabel: 'Freigegeben am (Server-Protokollfeld — nicht Teil des gehashten Dokuments)',
  notAvailable: '—',
};

const es: Record<TraceabilityStringKey, string> = {
  title: 'Documento de trazabilidad de control de calidad',
  previewWatermark: 'VISTA PREVIA — NO ES UN DOCUMENTO DE LIBERACIÓN',
  kindRelease: 'Registro de liberación',
  kindPreview: 'Vista previa pre-exportación (informe QC del cliente — nada ha sido liberado)',
  schemaVersionLabel: 'Versión del esquema del documento',

  identityHeading: 'Identidad de la restauración',
  caseLabel: 'Caso',
  restorationLabel: 'Restauración',
  typeLabel: 'Tipo',
  teethLabel: 'Dientes (FDI)',
  'type.crown': 'Corona',
  'type.inlay': 'Inlay (incrustación)',
  'type.onlay': 'Onlay (recubrimiento)',
  'type.bridge': 'Puente',

  qcHeading: 'Puertas de control de calidad',
  qcPassed: 'Todas las puertas aprobadas o reconocidas explícitamente.',
  qcFailed: 'HAY PUERTAS FALLIDAS — este estado no autoriza una exportación.',
  gateColumn: 'Puerta',
  measuredColumn: 'Valor medido',
  thresholdColumn: 'Umbral',
  statusColumn: 'Estado',
  messageColumn: 'Detalles',
  'gateStatus.pass': 'aprobada',
  'gateStatus.fail': 'FALLIDA',
  'gateStatus.acknowledged': 'FALLIDA — reconocida',
  'gate.watertight': 'Estanqueidad',
  'gate.manifold': 'Aristas manifold',
  'gate.selfIntersection': 'Autointersección',
  'gate.minWallThickness': 'Espesor mínimo de pared',
  'gate.marginFit': 'Ajuste marginal',
  'gate.seating': 'Asentamiento',
  'gate.connectorCrossSection': 'Sección transversal del conector',
  'gate.contact': 'Contactos oclusales/proximales',
  'gate.seamDihedral': 'Ángulo diedro de la costura',
  'gate.cuspCoverageThickness': 'Espesor de recubrimiento cuspídeo',
  'gate.ponticRelief': 'Alivio del póntico',

  ackHeading: 'Advertencias reconocidas',
  ackNotice:
    'Las siguientes puertas fallidas fueron reconocidas EXPLÍCITAMENTE por el operador (registradas en el diario — nunca omitidas en silencio). El firmante debe revisar cada una.',
  ackOperationLabel: 'Operación del diario',
  ackUnjournaledLabel: 'sin referencia en el diario',

  profileHeading: 'Perfil de material',
  profileIdLabel: 'Perfil',
  profileVersionLabel: 'Versión',
  profileChecksumLabel: 'Suma de verificación (JSON canónico, SHA-256)',

  versionsHeading: 'Versiones de software',
  kernelVersionLabel: 'Núcleo geométrico',
  manifoldVersionLabel: 'manifold-3d (motor booleano)',

  fileHeading: 'Archivo liberado',
  formatLabel: 'Formato',
  bytesHashLabel: 'SHA-256 de los bytes del archivo',
  byteLengthLabel: 'Tamaño del archivo (bytes)',
  meshContentHashLabel: 'Hash de contenido de la malla diseñada (Float64)',
  headerTextLabel: 'Texto de cabecera STL (registrado en el diario)',

  journalHeading: 'Vinculación con el diario',
  journalHashLabel: 'Hash del diario del caso',
  journalOpCountLabel: 'Operaciones del diario',
  exportOperationLabel: 'Operación de exportación',

  reimportHeading: 'Revalidación independiente del servidor',
  reimportHashLabel: 'Hash de contenido de la malla reimportada',
  'relation.stl-canonical-reindex-f32-narrowing':
    'Reimportación STL: reindexación canónica de vértices + estrechamiento a float32 respecto a la malla diseñada — los dos hashes de contenido difieren legítimamente; cada resultado de puerta se midió sobre los bytes reimportados.',
  'relation.ply-lossless-identity':
    'Reimportación PLY: ida y vuelta Float64 sin pérdidas — la malla reimportada es idéntica en contenido a la malla diseñada.',
  gateIdentityLine:
    'El servidor recalculó cada puerta sobre los bytes de exportación reimportados; los resultados son exactamente idénticos al informe del cliente (validación dual).',

  boundsHeading: 'Cotas de error del formato',
  boundsStlLine:
    'El STL binario almacena coordenadas float32. Error máximo de estrechamiento de este archivo: {bound} mm (cota analítica de medio ULP en la mayor magnitud de coordenada {maxCoord}).',
  boundsGateNote:
    'Las cotas de aproximación algorítmica de las mediciones QC individuales se transportan sin cambios en los resultados de puerta anteriores.',

  certHeading: 'Alcance de la certificación',
  'limitation.outer-envelope-not-certified':
    'NO CERTIFICADO: la envolvente exterior del sólido entregado. La liberación certifica los resultados de las puertas QC medidos sobre los bytes de exportación reimportados y su concordancia con el informe del cliente; ninguna puerta compara la forma exterior entregada con la malla fuente diseñada.',
  certRecordText: 'Texto del registro',

  releasedAtLabel:
    'Liberado el (campo de registro del servidor — no forma parte del documento con hash)',
  notAvailable: '—',
};

export const TRACEABILITY_STRINGS: Record<
  TraceabilityLocale,
  Record<TraceabilityStringKey, string>
> = {
  en,
  hu,
  de,
  es,
};
