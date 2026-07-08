import { injectable } from 'tsyringe';
import bcrypt from 'bcryptjs';

const SALT_ROUNDS = 12;

@injectable()
export class PasswordHasher {
  async hash(plain: string): Promise<string> {
    return bcrypt.hash(plain, SALT_ROUNDS);
  }

  async compare(plain: string, hash: string): Promise<boolean> {
    return bcrypt.compare(plain, hash);
  }
}
