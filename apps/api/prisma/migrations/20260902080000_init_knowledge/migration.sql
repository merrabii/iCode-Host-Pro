-- Phase 11 — base de connaissance (admin + client)
CREATE TYPE "KnowledgeAudience" AS ENUM ('ADMIN', 'CLIENT');
CREATE TYPE "KnowledgeType" AS ENUM ('INFORMATIVE', 'TECHNICAL', 'HOWTO');
CREATE TYPE "KnowledgeStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

CREATE TABLE "KnowledgeArticle" (
    "id" TEXT NOT NULL,
    "audience" "KnowledgeAudience" NOT NULL,
    "type" "KnowledgeType" NOT NULL,
    "status" "KnowledgeStatus" NOT NULL DEFAULT 'DRAFT',
    "title" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "summary" TEXT,
    "body" TEXT NOT NULL,
    "category" TEXT,
    "phase" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "authorId" TEXT,
    "authorEmail" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "publishedAt" TIMESTAMP(3),
    CONSTRAINT "KnowledgeArticle_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "KnowledgeArticle_audience_status_idx" ON "KnowledgeArticle"("audience", "status");
CREATE INDEX "KnowledgeArticle_audience_category_idx" ON "KnowledgeArticle"("audience", "category");
CREATE UNIQUE INDEX "KnowledgeArticle_audience_slug_key" ON "KnowledgeArticle"("audience", "slug");
ALTER TABLE "KnowledgeArticle" ADD CONSTRAINT "KnowledgeArticle_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
