-- CreateTable
CREATE TABLE "Export" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "caseId" TEXT NOT NULL,
    "restorationId" TEXT NOT NULL,
    "restorationType" TEXT NOT NULL,
    "teethJson" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "bytesSha256" TEXT NOT NULL,
    "byteLength" INTEGER NOT NULL,
    "meshContentHash" TEXT NOT NULL,
    "reimportMeshHash" TEXT NOT NULL,
    "exportOperationId" TEXT NOT NULL,
    "caseJournalHash" TEXT NOT NULL,
    "kernelVersion" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "profileVersion" TEXT NOT NULL,
    "profileChecksum" TEXT NOT NULL,
    "qcReportJson" TEXT NOT NULL,
    "acknowledgmentsJson" TEXT NOT NULL,
    "releasedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "ExportDiagnostic" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "caseId" TEXT NOT NULL,
    "restorationId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "bytesSha256" TEXT NOT NULL,
    "bundleJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "Export_bytesSha256_idx" ON "Export"("bytesSha256");

-- CreateIndex
CREATE INDEX "Export_caseId_idx" ON "Export"("caseId");

-- CreateIndex
CREATE INDEX "ExportDiagnostic_caseId_idx" ON "ExportDiagnostic"("caseId");
