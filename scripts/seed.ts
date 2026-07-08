import dotenv from 'dotenv';
import 'reflect-metadata';
import { container } from 'tsyringe';
import { registerDependencies } from '../src/shared/infrastructure/di/container';
import { PasswordHasher } from '../src/shared/infrastructure/security/PasswordHasher';
import { generateId } from '../src/shared/infrastructure/utils/crypto.utils';
import { User } from '../src/modules/identity/domain/entities/User';
import { UserRole, UserStatus } from '../src/modules/identity/domain/entities/User.types';
import { UserRepositoryDynamo } from '../src/modules/identity/infrastructure/persistence/UserRepositoryDynamo';

dotenv.config();
registerDependencies();

async function seed(): Promise<void> {
  const email = process.env.SEED_ADMIN_EMAIL ?? 'admin@iaventas.com';
  const password = process.env.SEED_ADMIN_PASSWORD ?? 'Admin123!';

  const userRepo = container.resolve(UserRepositoryDynamo);
  const passwordHasher = container.resolve(PasswordHasher);

  const existing = await userRepo.findByEmail(email);
  if (existing) {
    console.log(`Admin user already exists: ${email}`);
    return;
  }

  const now = new Date().toISOString();
  const admin = User.create(
    {
      email,
      passwordHash: await passwordHasher.hash(password),
      role: UserRole.ADMIN,
      tenantId: null,
      status: UserStatus.ACTIVE,
      profile: { firstName: 'Admin', lastName: 'Sistema' },
      createdAt: now,
      updatedAt: now,
    },
    generateId()
  );

  await userRepo.save(admin);
  console.log(`Admin user created: ${email}`);
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
