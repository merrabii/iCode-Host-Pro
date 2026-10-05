-- GO Q12 (revue post-patch) : familles de session pour refresh tokens.
-- Additive uniquement : colonne + index. Les lignes existantes reçoivent un
-- sessionId SQL aléatoire (une session historique = une famille à elle seule :
-- aucun élargissement de révocation rétroactif).
ALTER TABLE "RefreshToken" ADD COLUMN "sessionId" TEXT NOT NULL DEFAULT gen_random_uuid()::text;

-- CreateIndex
CREATE INDEX "RefreshToken_userId_sessionId_idx" ON "RefreshToken"("userId", "sessionId");
