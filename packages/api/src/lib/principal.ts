export const ROLES = ['reader', 'contributor', 'curator', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export const USER_KINDS = ['human', 'service'] as const;
export type UserKind = (typeof USER_KINDS)[number];

/** The authenticated caller of a request (resolved from its API token). */
export interface Principal {
  userId: string;
  role: Role;
  kind: UserKind;
}

/** Fixed service/admin user created by migration 0001, used by the CLI and bootstrap. */
export const SYSTEM_USER_ID = '00000000-0000-7000-8000-000000000000';
export const SYSTEM_PRINCIPAL: Principal = { userId: SYSTEM_USER_ID, role: 'admin', kind: 'service' };

/** Roles are cumulative: admin > curator > contributor > reader. */
export function hasRole(principal: Pick<Principal, 'role'>, required: Role): boolean {
  return ROLES.indexOf(principal.role) >= ROLES.indexOf(required);
}
