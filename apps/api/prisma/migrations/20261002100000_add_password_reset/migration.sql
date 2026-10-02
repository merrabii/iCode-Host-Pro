-- GO socle (lot A1) - jetons de reinitialisation de mot de passe.
--
-- STRICTEMENT ADDITIVE : 1 nouvelle table independante. Aucune ALTER sur une
-- table existante, aucun DROP/UPDATE/DELETE, aucune modification de contrainte.
-- Les anciennes migrations restent inchangees.
--
--   -> tokenHash : sha256 du jeton brut (jamais stocke en clair, meme
--                  convention que RefreshToken.tokenHash / Invitation.tokenHash)
--   -> expiresAt : TTL court (defaut 30 min, borne 5 min .. 24 h)
--   -> usedAt    : usage unique - une fois consomme, le lien est mort

-- CreateTable
CREATE TABLE "PasswordResetToken" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PasswordResetToken_tokenHash_key" ON "PasswordResetToken"("tokenHash");

-- CreateIndex
CREATE INDEX "PasswordResetToken_userId_idx" ON "PasswordResetToken"("userId");

-- AddForeignKey
ALTER TABLE "PasswordResetToken" ADD CONSTRAINT "PasswordResetToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
