// Phase 2 — Controlled, idempotent ADMIN bootstrap (ADR-017).
// Ensures a platform ADMIN account exists for development, WITHOUT committing any
// secret to Git. Credentials come from apps/api/.env (gitignored); .env.example
// carries placeholders only.
//
// Idempotency contract:
//   - If the ADMIN_EMAIL user does not exist → create it as role ADMIN with the
//     env password (hashed, bcrypt cost 10).
//   - If it already exists → promote it to ADMIN + isActive (but NEVER overwrite
//     its passwordHash, so an existing admin's password is never clobbered).
// Re-runs are safe (no-op aside from ensuring role/isActive).

import 'dotenv/config';
import { PrismaClient, Role } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;

  if (!email || !password) {
    throw new Error(
      'ADMIN_EMAIL and ADMIN_PASSWORD must be set in apps/api/.env to run the admin seed.',
    );
  }

  const admin = await prisma.user.upsert({
    where: { email },
    update: {
      // Never reset an existing account's password; just ensure it is an active ADMIN.
      role: Role.ADMIN,
      isActive: true,
      name: 'Platform Admin',
    },
    create: {
      email,
      passwordHash: await bcrypt.hash(password, 10),
      name: 'Platform Admin',
      role: Role.ADMIN,
      isActive: true,
    },
  });

  console.log(`Admin ensured: ${admin.email} (role=${admin.role}, isActive=${admin.isActive})`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());