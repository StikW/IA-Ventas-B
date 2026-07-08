import { Entity } from '../../../../shared/domain/Entity';
import { UserProps, UserRole, UserStatus } from './User.types';

export class User extends Entity<UserProps> {
  private constructor(props: UserProps, id: string) {
    super(props, id);
  }

  static create(props: UserProps, id: string): User {
    return new User(props, id);
  }

  get email(): string {
    return this.props.email;
  }

  get passwordHash(): string {
    return this.props.passwordHash;
  }

  get role(): UserRole {
    return this.props.role;
  }

  get tenantId(): string | null {
    return this.props.tenantId;
  }

  get status(): UserStatus {
    return this.props.status;
  }

  get profile(): UserProps['profile'] {
    return this.props.profile;
  }

  get createdAt(): string {
    return this.props.createdAt;
  }

  get updatedAt(): string {
    return this.props.updatedAt;
  }

  get lastLoginAt(): string | undefined {
    return this.props.lastLoginAt;
  }

  isActive(): boolean {
    return this.props.status === UserStatus.ACTIVE;
  }

  isAdmin(): boolean {
    return this.props.role === UserRole.ADMIN;
  }

  toJSON() {
    return {
      id: this.id,
      email: this.email,
      role: this.role,
      tenantId: this.tenantId,
      status: this.status,
      profile: this.profile,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      lastLoginAt: this.lastLoginAt,
    };
  }
}
