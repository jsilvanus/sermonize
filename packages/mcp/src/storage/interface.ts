export interface AuthorizationCodeRecord {
  code: string;
  clientId: string;
  redirectUri: string;
  challenge: string;
  subject: string;
  scope: string;
  expires: number;
}

export interface RefreshTokenRecord {
  token: string;
  clientId: string;
  subject: string;
  scope: string;
  expires: number;
}

export interface AuthStore {
  saveAuthorizationCode(record: AuthorizationCodeRecord): void;
  consumeAuthorizationCode(code: string): AuthorizationCodeRecord | undefined;
  saveRefreshToken(record: RefreshTokenRecord): void;
  getRefreshToken(token: string): RefreshTokenRecord | undefined;
}

export interface McpUser {
  id: string;
  name: string;
  email?: string;
  passwordHash?: string;
  createdAt: number;
}

export interface UserStore {
  createUser(user: McpUser): void;
  listUsers(): McpUser[];
  getUser(id: string): McpUser | undefined;
  getUserByEmail(email: string): McpUser | undefined;
  updateUser(id: string, patch: { name?: string; email?: string; passwordHash?: string }): McpUser | undefined;
  deleteUser(id: string): boolean;
}
