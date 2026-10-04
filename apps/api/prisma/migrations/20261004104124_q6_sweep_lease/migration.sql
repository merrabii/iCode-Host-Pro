-- CreateTable
CREATE TABLE "SweepLease" (
    "name" TEXT NOT NULL,
    "holder" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SweepLease_pkey" PRIMARY KEY ("name")
);
